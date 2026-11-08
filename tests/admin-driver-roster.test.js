"use strict";

const assert = require("node:assert/strict");
const { generateKeyPairSync } = require("node:crypto");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const jwt = require("jsonwebtoken");
const { handleDriverRoster } = require("../src/admin/driverRoster");

test("only configured admins can list, add, enable, remove, and delete drivers", async (t) => {
  const issuer = "https://test.cloudflareaccess.com";
  const audience = "test-admin-app";
  const driverAudience = "test-driver-app";
  const manager = "manager@example.test";
  const account = "0123456789abcdef0123456789abcdef";
  const list = "01234567-89ab-cdef-0123-456789abcdef";
  const listsUrl = `https://api.cloudflare.com/client/v4/accounts/${account}/gateway/lists`;
  const listUrl = `${listsUrl}/${list}`;
  const listToken = "sample-list-api-token";
  const env = {
    ADMIN_ACCESS_ISSUER: issuer,
    ADMIN_ACCESS_AUDIENCE: audience,
    DRIVER_ACCESS_AUDIENCE: driverAudience,
    ADMIN_DRIVER_MANAGER_EMAILS: manager,
    CLOUDFLARE_ACCOUNT_ID: account,
    CLOUDFLARE_DRIVER_EMAIL_LIST_ID: list,
    CLOUDFLARE_DRIVER_LIST_TOKEN: listToken,
  };
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }

  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "sample-access-key";
  let listMode = "append";
  let listName = "Smiles In Route Driver Login";
  let discoveredLists = [];
  const listCalls = [];
  t.mock.method(global, "fetch", async (url, options) => {
    if (url === issuer + "/cdn-cgi/access/certs") {
      return Response.json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid }] });
    }
    assert.equal(options.headers.Authorization, `Bearer ${listToken}`);
    const method = options.method || "GET";
    listCalls.push([method, url]);
    if (url === listsUrl && method === "GET") {
      if (listMode === "denied") return Response.json({ success: false }, { status: 403 });
      return Response.json({ success: true, result: discoveredLists });
    }
    if (url === listUrl && method === "GET") {
      return Response.json({ success: true, result: { type: "EMAIL", name: listName } });
    }
    if (url === listUrl && method === "PATCH") {
      assert.deepEqual(JSON.parse(options.body), { append: [{ value: "driver@example.test" }] });
      return Response.json({ success: listMode === "append" });
    }
    assert.equal(url, listUrl + "/items");
    return Response.json({
      success: true,
      result: listMode === "retry" ? [{ value: "driver@example.test" }] : [],
    });
  });
  const sign = (email, aud = audience) => jwt.sign({ email }, privateKey, {
    algorithm: "RS256", keyid: kid, issuer, audience: aud, expiresIn: "5m",
  });

  const drivers = [];
  const pool = {
    async query(sql, params) {
      if (sql.startsWith("SELECT")) {
        assert.match(sql, /WHERE company_id = \$1/);
        assert.deepEqual(params, [1]);
        return { rows: drivers.map((driver) => ({ ...driver, open_jobs: 0, can_delete: true })) };
      }
      assert.match(sql, /'offline', false, false/);
      assert.match(sql, /lower\(email\) = \$2/);
      assert.match(sql, /ON CONFLICT \(email\) DO NOTHING/);
      const [name, email, phone, vehicle_type, companyId] = params;
      assert.equal(companyId, 1);
      if (drivers.some((driver) => driver.email.toLowerCase() === email)) return { rows: [] };
      const driver = { id: "sample-driver", name, email, phone, vehicle_type, active: false, status: "offline" };
      drivers.push(driver);
      return { rows: [driver] };
    },
  };

  async function request(method, token, body, connection = pool, photoId) {
    const req = new PassThrough();
    req.headers = token ? { "cf-access-jwt-assertion": token } : { authorization: "Bearer sample-admin-key" };
    if (photoId !== undefined) {
      req.url = "/admin/drivers?photo=" + encodeURIComponent(photoId);
      if (method === "PUT") req.headers["content-type"] = "image/jpeg";
    }
    req.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body ?? {}));
    const headers = {};
    let output;
    try {
      await handleDriverRoster(
        req,
        {
          setHeader: (name, value) => { headers[name] = value; },
          end(payload) { output = { status: this.statusCode, payload, headers }; },
        },
        connection,
        method,
        (_res, status, payload) => { output = { status, payload, headers }; }
      );
      return output;
    } catch (error) {
      if (!error.statusCode) throw error;
      return { status: error.statusCode, message: error.message };
    }
  }

  const denyQuery = () => assert.fail("Rejected request reached the database");
  const noDataAccess = { query: denyQuery, connect: denyQuery };
  const token = sign(manager);
  assert.equal((await request("GET", undefined, null, noDataAccess)).status, 401);
  assert.equal((await request("POST", sign(manager, "other-app"), {}, noDataAccess)).status, 401);
  assert.equal((await request("GET", sign(manager, driverAudience), null, noDataAccess)).status, 401);
  assert.equal((await request("POST", sign(manager, driverAudience), {}, noDataAccess)).status, 401);
  assert.equal((await request("POST", sign("driver@example.test"), {}, noDataAccess)).status, 403);
  assert.equal((await request("PATCH", sign(manager, driverAudience), {}, noDataAccess)).status, 401);
  assert.equal((await request("PUT", sign(manager, driverAudience), {}, noDataAccess)).status, 401);
  assert.equal((await request("DELETE", sign("driver@example.test"), {}, noDataAccess)).status, 403);
  process.env.ADMIN_ACCESS_AUDIENCE = driverAudience;
  assert.equal((await request("POST", sign(manager, driverAudience), {}, noDataAccess)).status, 503);
  delete process.env.ADMIN_ACCESS_AUDIENCE;
  assert.equal((await request("GET", token, null, noDataAccess)).status, 503);
  process.env.ADMIN_ACCESS_AUDIENCE = audience;
  delete process.env.ADMIN_DRIVER_MANAGER_EMAILS;
  assert.equal((await request("POST", token, {}, noDataAccess)).status, 503);
  process.env.ADMIN_DRIVER_MANAGER_EMAILS = manager;

  assert.equal((await request("POST", token, "{", noDataAccess)).status, 400);
  assert.equal((await request("POST", token, " ".repeat(4097), noDataAccess)).status, 413);
  assert.equal((await request("POST", token, { email: "broken" }, noDataAccess)).status, 400);
  const fields = { name: "Sample Driver", email: "Driver@Example.Test", phone: "503-555-0100", vehicle_type: "car" };
  assert.equal((await request("POST", token, { ...fields, phone: "abc" }, noDataAccess)).status, 400);
  assert.equal((await request("POST", token, { ...fields, vehicle_type: "unknown" }, noDataAccess)).status, 400);

  const created = await request("POST", token, { ...fields, active: true, selfie_verified: true, company_id: 2 });
  assert.equal(created.status, 201);
  assert.equal(created.payload.driver.email, "driver@example.test");
  assert.equal(created.payload.driver.active, false);
  assert.equal((await request("POST", token, fields)).status, 409);

  const roster = await request("GET", token);
  assert.equal(roster.headers["Cache-Control"], "no-store");
  assert.equal(roster.payload.login_setup_available, true);
  assert.deepEqual(roster.payload.drivers, [created.payload.driver]);

  const id = "a1b2c3d4-1234-1234-1234-123456789abc";
  assert.equal((await request("PATCH", token, { id: "bad" }, noDataAccess)).status, 400);

  function transaction(steps) {
    const remaining = [...steps];
    return {
      async connect() {
        return {
          async query(sql, params) {
            const step = remaining.shift();
            assert.ok(step, `Unexpected query: ${sql}`);
            const [expectedSql, expectedParams, result] = step;
            assert.match(sql, expectedSql);
            assert.deepEqual(params, expectedParams);
            return result;
          },
          release() { assert.equal(remaining.length, 0); },
        };
      },
    };
  }

  const scope = [1, id];
  const begin = [/^BEGIN$/, undefined];
  const commit = [/^COMMIT$/, undefined];
  const rollback = [/^ROLLBACK$/, undefined];
  const photo = Buffer.from([0xff, 0xd8, 0xff, 0x01, 0xff, 0xd9]);
  const record = { rowCount: 1, rows: [{ id }] };
  const photoLock = [/WHERE company_id = \$1 AND id = \$2 FOR SHARE/, scope, record];
  const photoPath = "driver-records/" + id + ".jpg";
  const storageModule = require.resolve("../src/lib/supabase");
  let savedPhoto;
  require.cache[storageModule] = { exports: { supabase: { storage: { from(bucket) {
    assert.equal(bucket, "driver-documents");
    return {
      async upload(path, bytes, options) {
        assert.equal(path, photoPath);
        assert.equal(options.upsert, true);
        savedPhoto = bytes;
        return { error: null };
      },
      async download(path) {
        assert.equal(path, photoPath);
        assert.ok(savedPhoto, "An empty driver record must not call Storage download");
        return { data: new Blob([savedPhoto]), error: null };
      },
    };
  } } } } };
  t.after(() => { delete require.cache[storageModule]; });

  const photoPool = { async query(sql, params) {
    assert.match(sql, /FROM storage\.objects/);
    assert.match(sql, /WHERE d\.company_id = \$1 AND d\.id = \$2/);
    assert.deepEqual(params, [...scope, "driver-documents", "driver-records/"]);
    return { rowCount: 1, rows: [{ id, has_photo: Boolean(savedPhoto) }] };
  } };
  assert.equal((await request("GET", sign(manager, driverAudience), null, noDataAccess, id)).status, 401);
  assert.equal((await request("PUT", sign("driver@example.test"), photo, noDataAccess, id)).status, 403);
  assert.equal((await request("PUT", token, "not a photo", noDataAccess, id)).status, 400);
  assert.equal((await request("GET", token, null, noDataAccess, "../../bad")).status, 400);
  assert.deepEqual(await request("GET", token, null, photoPool, id), {
    status: 404, message: "No photo on file for this driver.",
  });
  assert.equal((await request("PUT", token, photo, transaction([begin, photoLock, commit]), id)).status, 200);
  const storedPhoto = await request("GET", token, null, photoPool, id);
  assert.equal(storedPhoto.status, 200);
  assert.equal(storedPhoto.headers["Cache-Control"], "no-store");
  assert.equal(storedPhoto.headers["Content-Type"], "image/jpeg");
  assert.deepEqual(storedPhoto.payload, photo);
  const lock = [/SELECT id, email FROM drivers WHERE company_id = \$1 AND id = \$2 FOR UPDATE/, scope, {
    rowCount: 1, rows: [{ id, email: "Driver@Example.Test" }],
  }];
  const deactivated = { ...created.payload.driver, id, active: false, open_jobs: 2, can_delete: false };
  const removal = transaction([
    begin,
    lock,
    [/UPDATE drivers SET active = false, status = 'offline'/, scope],
    [/DELETE FROM driver_sessions WHERE driver_id = \$1/, [id]],
    [/AS open_jobs/, scope, { rows: [deactivated] }],
    commit,
  ]);
  assert.deepEqual((await request("PATCH", token, { id }, removal)).payload, { driver: deactivated });

  const deleteSql = /DELETE FROM drivers d WHERE company_id = \$1 AND id = \$2[\s\S]+NOT EXISTS \(SELECT 1 FROM orders WHERE assigned_driver_id = d.id\)[\s\S]+NOT EXISTS \(SELECT 1 FROM order_photos WHERE driver_id = d.id\)/;
  const used = transaction([begin, lock, [deleteSql, scope, { rowCount: 0 }], rollback]);
  assert.equal((await request("DELETE", token, { id }, used)).status, 409);

  const unused = transaction([begin, lock, [deleteSql, scope, { rowCount: 1, rows: [{ id }] }], commit]);
  assert.deepEqual((await request("DELETE", token, { id }, unused)).payload, { id });

  const wrongCompany = transaction([begin, [lock[0], scope, { rowCount: 0 }], rollback]);
  assert.equal((await request("DELETE", token, { id }, wrongCompany)).status, 404);

  delete process.env.CLOUDFLARE_DRIVER_LIST_TOKEN;
  assert.equal((await request("PUT", token, { id }, noDataAccess)).status, 503);
  assert.equal((await request("GET", token)).payload.login_setup_available, false);
  process.env.CLOUDFLARE_DRIVER_LIST_TOKEN = listToken;

  const enabled = { ...deactivated, active: true, selfie_verified: false };
  const enableTransaction = () => transaction([
    begin,
    lock,
    [/UPDATE drivers SET active = true WHERE company_id = \$1 AND id = \$2/, scope],
    [/AS open_jobs/, scope, { rows: [enabled] }],
    commit,
  ]);
  assert.deepEqual((await request("PUT", token, { id, email: "other@example.test" }, enableTransaction())).payload, { driver: enabled });
  assert.deepEqual(listCalls.splice(0), [["GET", listUrl], ["PATCH", listUrl]]);

  listMode = "retry";
  assert.equal((await request("PUT", token, { id }, enableTransaction())).status, 200);
  assert.deepEqual(listCalls.splice(0), [["GET", listUrl], ["PATCH", listUrl], ["GET", listUrl + "/items"]]);

  listMode = "failed";
  assert.equal((await request("PUT", token, { id }, transaction([begin, lock, rollback]))).status, 424);
  assert.deepEqual(listCalls.splice(0), [["GET", listUrl], ["PATCH", listUrl], ["GET", listUrl + "/items"]]);

  listName = "Admin Login";
  assert.equal((await request("PUT", token, { id }, transaction([begin, lock, rollback]))).status, 424);
  assert.deepEqual(listCalls.splice(0), [["GET", listUrl]]);

  delete process.env.CLOUDFLARE_DRIVER_EMAIL_LIST_ID;
  assert.equal((await request("GET", token)).payload.login_setup_available, true);
  listMode = "append";
  const driverList = { id: list, name: "Smiles In Route Driver Login", type: "EMAIL" };
  discoveredLists = [{ id: list, name: "Admin Login", type: "EMAIL" }, driverList];
  assert.equal((await request("PUT", token, { id }, enableTransaction())).status, 200);
  assert.deepEqual(listCalls.splice(0), [["GET", listsUrl], ["PATCH", listUrl]]);

  discoveredLists = [driverList, { ...driverList, id: "98765432-89ab-cdef-0123-456789abcdef" }];
  assert.equal((await request("PUT", token, { id }, transaction([begin, lock, rollback]))).status, 424);
  assert.deepEqual(listCalls.splice(0), [["GET", listsUrl]]);

  discoveredLists = [];
  const missingList = await request("PUT", token, { id }, transaction([begin, lock, rollback]));
  assert.equal(missingList.status, 424);
  assert.match(missingList.message, /exactly one User Emails list/);
  assert.deepEqual(listCalls.splice(0), [["GET", listsUrl]]);

  listMode = "denied";
  const denied = await request("PUT", token, { id }, transaction([begin, lock, rollback]));
  assert.equal(denied.status, 424);
  assert.match(denied.message, /Cloudflare rejected the token/);
  assert.ok(!denied.message.includes(listToken));
  assert.deepEqual(listCalls, [["GET", listsUrl]]);
});
