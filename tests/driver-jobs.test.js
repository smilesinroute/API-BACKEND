"use strict";

const assert = require("node:assert/strict");
const { generateKeyPairSync } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const jwt = require("jsonwebtoken");
const { handleDriverOrders } = require("../src/drivers/driverOrders");

const entry = { exports: {} };
vm.runInNewContext(readFileSync(join(__dirname, "../index.js"), "utf8"), {
  module: entry,
  require(name) {
    if (name === "url") return require("url");
    if (name === "./src/drivers/driverOrders") return { handleDriverOrders };
    return new Proxy({}, { get: () => async () => false });
  },
  process: { env: {} },
  console,
});
const { handleAPI } = entry.exports;

async function request(pool, headers, url = "/api/driver/orders", method = "GET") {
  const res = {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { this.body = JSON.parse(body); this.writableEnded = true; },
  };
  await handleAPI({ headers: { host: "example.test", ...headers }, url, method }, res, pool);
  return res;
}

test("driver jobs route checks Cloudflare identity and returns only assigned courier jobs", async (t) => {
  const issuer = "https://driver-test.cloudflareaccess.com";
  const audience = "sample-driver-app";
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "sample-key";
  const sign = (email, overrides = {}) => jwt.sign({ email }, privateKey, {
    algorithm: "RS256", keyid: kid, issuer, audience, expiresIn: "5m", ...overrides,
  });
  t.mock.method(global, "fetch", async (url) => {
    assert.equal(url, `${issuer}/cdn-cgi/access/certs`);
    return Response.json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid }] });
  });
  const previousIssuer = process.env.DRIVER_ACCESS_ISSUER;
  const previousAudience = process.env.DRIVER_ACCESS_AUDIENCE;
  t.after(() => {
    if (previousIssuer === undefined) delete process.env.DRIVER_ACCESS_ISSUER;
    else process.env.DRIVER_ACCESS_ISSUER = previousIssuer;
    if (previousAudience === undefined) delete process.env.DRIVER_ACCESS_AUDIENCE;
    else process.env.DRIVER_ACCESS_AUDIENCE = previousAudience;
  });
  delete process.env.DRIVER_ACCESS_ISSUER;
  delete process.env.DRIVER_ACCESS_AUDIENCE;

  const deniedPool = { query: () => assert.fail("Denied request queried driver data") };
  assert.equal((await request(deniedPool, {})).statusCode, 503);
  process.env.DRIVER_ACCESS_ISSUER = issuer;
  process.env.DRIVER_ACCESS_AUDIENCE = audience;
  assert.equal((await request(deniedPool, { authorization: "Bearer untrusted" })).statusCode, 401);
  for (const token of [
    sign("one@example.test", { audience: "admin-app" }),
    sign("one@example.test", { expiresIn: -1 }),
    sign("one@example.test", { issuer: "https://other-team.cloudflareaccess.com" }),
  ]) {
    assert.equal((await request(deniedPool, { "cf-access-jwt-assertion": token })).statusCode, 401);
  }

  const drivers = new Map([
    ["one@example.test", { id: "driver-one", active: true, selfie_verified: true }],
    ["two@example.test", { id: "driver-two", active: true, selfie_verified: true }],
    ["new@example.test", { id: "driver-new", active: true, selfie_verified: false }],
    ["inactive@example.test", { id: "driver-inactive", active: false }],
  ]);
  const pool = {
    async query(sql, [value]) {
      if (sql.includes("FROM drivers")) {
        return { rows: drivers.has(value) ? [drivers.get(value)] : [] };
      }
      assert.match(sql, /WHERE assigned_driver_id = \$1\s+AND service_type = 'courier'/);
      assert.doesNotMatch(sql, /assigned_driver_id IS NULL/);
      assert.notEqual(value, "driver-inactive");
      if (value === "driver-new") return { rows: [{ id: "new-driver-job" }] };
      return { rows: value === "driver-one" ? [{ id: "sample-job" }] : [] };
    },
  };
  const withEmail = (email) => request(pool, { "cf-access-jwt-assertion": sign(email) });
  const assigned = await withEmail("One@example.test");
  assert.equal(assigned.statusCode, 200);
  assert.equal(assigned.headers["Cache-Control"], "no-store");
  assert.deepEqual(assigned.body.orders, [{ id: "sample-job" }]);
  assert.deepEqual((await withEmail("two@example.test")).body.orders, []);
  const newDriver = await withEmail("new@example.test");
  assert.equal(newDriver.statusCode, 200);
  assert.deepEqual(newDriver.body.orders, [{ id: "new-driver-job" }]);
  assert.equal((await withEmail("inactive@example.test")).statusCode, 403);
  assert.equal((await withEmail("unregistered@example.test")).statusCode, 403);
  assert.equal((await request(deniedPool, {}, "/api/driver/order/sample-job/start", "POST")).statusCode, 404);
});
