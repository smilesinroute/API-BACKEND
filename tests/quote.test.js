"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { PassThrough } = require("node:stream");

// Run the real public router and quote handler without loading unrelated
// admin/driver integrations or using a live database or Google account.
const routerModule = { exports: {} };
vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, "../index.js"), "utf8"),
  {
    module: routerModule,
    process,
    console,
    require(id) {
      if (id === "url") return require("node:url");
      if (id === "./src/routes/quote") return require("../src/routes/quote");
      return new Proxy({}, { get: () => async () => false });
    },
  }
);
const { handleAPI } = routerModule.exports;

const payload = {
  serviceType: "courier",
  region: "oregon",
  vehicleType: "sedan",
  pickupAddress: "Public pickup test address",
  dropoffAddress: "Public delivery test address",
};

// Fixture rates verify the calculation; they do not set business prices.
const pricing = {
  base_fee: "25.00",
  rate_per_mile: "2.25",
  fragile_fee: "10.00",
  priority_fee: "20.00",
  time_sensitive_fee: "15.00",
  after_hours_fee: "5.00",
};

async function request(body, { method = "POST", url = "/api/quote", pool } = {}) {
  const req = new PassThrough();
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost", origin: "https://smilesinroute.delivery" };
  const res = {
    statusCode: 200,
    writableEnded: false,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(value = "") { this.body = value; this.writableEnded = true; },
  };
  const pending = handleAPI(req, res, pool);
  req.end(JSON.stringify(body));
  await pending;
  assert.equal(res.writableEnded, true, "router must finish the response");
  return { ...res, data: res.body ? JSON.parse(res.body) : null };
}

function stubGoogle(t, status = "OK") {
  const previousKey = process.env.GOOGLE_MAPS_API_KEY;
  process.env.GOOGLE_MAPS_API_KEY = "quote-test-key";
  t.after(() => {
    if (previousKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = previousKey;
  });
  return t.mock.method(global, "fetch", async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.hostname, "maps.googleapis.com");
    assert.equal(parsed.searchParams.get("origins"), payload.pickupAddress);
    assert.equal(parsed.searchParams.get("destinations"), payload.dropoffAddress);
    return {
      ok: true,
      json: async () => ({
        status: "OK",
        rows: [{ elements: [{ status, distance: { value: 7242.03 } }] }],
      }),
    };
  });
}

test("public /api/quote reaches server pricing and returns display amounts", async (t) => {
  const google = stubGoogle(t);
  const queries = [];
  const pool = { query: async (sql, params) => {
    queries.push({ sql, params });
    return { rows: [pricing] };
  } };
  const res = await request(payload, { pool });
  assert.equal(res.statusCode, 200);
  assert.equal(res.data.ok, true);
  assert.equal(res.data.distance, 4.5);
  assert.equal(res.data.breakdown.baseFee, 25);
  assert.equal(res.data.breakdown.mileageCost, 10.13);
  assert.equal(res.data.total, 35.13);
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /FROM pricing/);
  assert.deepEqual(Array.from(queries[0].params), ["oregon", "courier", "sedan"]);
  assert.equal(google.mock.callCount(), 1);
  assert.equal(res.headers["Access-Control-Allow-Origin"], "https://smilesinroute.delivery");
});

test("selected vehicle and add-ons use database rates", async (t) => {
  stubGoogle(t);
  const pool = { query: async (_, params) => {
    assert.deepEqual(Array.from(params), ["oregon", "courier", "cargo"]);
    return { rows: [pricing] };
  } };
  const res = await request({ ...payload, vehicleType: "cargo", fragile: true,
    priority: true, timeSensitive: true, afterHours: true }, { pool });
  assert.equal(res.statusCode, 200);
  assert.equal(res.data.total, 85.13);
  assert.equal(res.data.breakdown.fragile, 10);
  assert.equal(res.data.breakdown.priority, 20);
  assert.equal(res.data.breakdown.timeSensitive, 15);
  assert.equal(res.data.breakdown.afterHours, 5);
});

test("client-supplied distance and total cannot replace the server quote", async (t) => {
  stubGoogle(t);
  const res = await request({ ...payload, distance_miles: 999, total_amount: 1 }, {
    pool: { query: async () => ({ rows: [pricing] }) },
  });
  assert.equal(res.data.distance, 4.5);
  assert.equal(res.data.total, 35.13);
});

test("missing contract fields are rejected before querying pricing", async () => {
  const pool = { query: async () => assert.fail("no database access expected") };
  const res = await request({}, { pool });
  assert.equal(res.statusCode, 400);
  assert.match(res.data.error, /serviceType and region/);
});

test("missing courier addresses are rejected before external work", async () => {
  const pool = { query: async () => assert.fail("no database access expected") };
  const res = await request({ ...payload, pickupAddress: "" }, { pool });
  assert.equal(res.statusCode, 400);
  assert.match(res.data.error, /pickupAddress and dropoffAddress/);
});

test("missing pricing produces an error rather than a zero quote", async (t) => {
  t.mock.method(console, "error", () => {});
  const res = await request(payload, { pool: { query: async () => ({ rows: [] }) } });
  assert.equal(res.statusCode, 500);
  assert.equal(res.data.error, "No pricing rule found");
  assert.equal(res.data.total, undefined);
});

test("an undrivable route produces an error rather than a quote", async (t) => {
  stubGoogle(t, "ZERO_RESULTS");
  t.mock.method(console, "error", () => {});
  const res = await request(payload, { pool: { query: async () => ({ rows: [pricing] }) } });
  assert.equal(res.statusCode, 500);
  assert.match(res.data.error, /No drivable route/);
  assert.equal(res.data.total, undefined);
});

test("preflight succeeds without quoting or querying the database", async () => {
  const res = await request({}, { method: "OPTIONS", pool: {
    query: async () => assert.fail("no database access expected"),
  } });
  assert.equal(res.statusCode, 204);
});

test("GET does not invoke the POST-only quote handler", async () => {
  const res = await request({}, { method: "GET", pool: {
    query: async () => assert.fail("no database access expected"),
  } });
  assert.equal(res.statusCode, 404);
});

test("existing health route still works", async () => {
  const res = await request({}, { method: "GET", url: "/api/health", pool: {
    query: async (sql) => { assert.equal(sql, "SELECT 1"); return { rows: [] }; },
  } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.data.status, "ok");
});
