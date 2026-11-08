"use strict";

const assert = require("node:assert/strict");
const { generateKeyPairSync } = require("node:crypto");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const jwt = require("jsonwebtoken");
const { handleDriverRoster } = require("../src/admin/driverRoster");

test("only configured admins can list and add inactive drivers", async (t) => {
  const issuer = "https://test.cloudflareaccess.com";
  const audience = "test-admin-app";
  const driverAudience = "test-driver-app";
  const manager = "manager@example.test";
  const env = {
    ADMIN_ACCESS_ISSUER: issuer,
    ADMIN_ACCESS_AUDIENCE: audience,
    DRIVER_ACCESS_AUDIENCE: driverAudience,
    ADMIN_DRIVER_MANAGER_EMAILS: manager,
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
  t.mock.method(global, "fetch", async (url) => {
    assert.equal(url, issuer + "/cdn-cgi/access/certs");
    return Response.json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid }] });
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
        return { rows: [...drivers] };
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

  async function request(method, token, body, connection = pool) {
    const req = new PassThrough();
    req.headers = token ? { "cf-access-jwt-assertion": token } : { authorization: "Bearer sample-admin-key" };
    req.end(typeof body === "string" ? body : JSON.stringify(body ?? {}));
    const headers = {};
    let output;
    try {
      await handleDriverRoster(
        req,
        { setHeader: (name, value) => { headers[name] = value; } },
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

  const noDataAccess = { query: () => assert.fail("Unauthorized request reached the database") };
  const token = sign(manager);
  assert.equal((await request("GET", undefined, null, noDataAccess)).status, 401);
  assert.equal((await request("POST", sign(manager, "other-app"), {}, noDataAccess)).status, 401);
  assert.equal((await request("GET", sign(manager, driverAudience), null, noDataAccess)).status, 401);
  assert.equal((await request("POST", sign(manager, driverAudience), {}, noDataAccess)).status, 401);
  assert.equal((await request("POST", sign("driver@example.test"), {}, noDataAccess)).status, 403);
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
  assert.deepEqual(roster.payload.drivers, [created.payload.driver]);
});
