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
  base_rate: "25.00",
  per_mile_rate: "2.25",
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
  assert.match(queries[0].sql, /FROM public\.pricing_config/);
  assert.match(queries[0].sql, /active = true/);
  assert.match(queries[0].sql, /LIMIT 2/);
  assert.deepEqual(Array.from(queries[0].params), ["oregon", "courier", "standard"]);
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
  assert.equal(res.data.total, 65.13);
  assert.equal(res.data.breakdown.fragile, 10);
  assert.equal(res.data.breakdown.priority, 0);
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
  assert.match(res.data.error, /No active pricing rule found/);
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

test("existing pricing_config fields work without optional surcharge columns", async (t) => {
  stubGoogle(t);
  const row = { base_rate: "25.00", per_mile_rate: "2.25",
    fragile_fee: "10.00", priority_fee: "15.00" };
  const res = await request({ ...payload, fragile: true, priority: true }, {
    pool: { query: async () => ({ rows: [row] }) },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.data.total, 60.13);
  assert.equal(res.data.breakdown.timeSensitive, 0);
  assert.equal(res.data.breakdown.afterHours, 0);
});

test("duplicate active rates cannot silently select a price", async (t) => {
  t.mock.method(console, "error", () => {});
  const res = await request(payload, {
    pool: { query: async () => ({ rows: [pricing, { ...pricing, base_rate: "40" }] }) },
  });
  assert.equal(res.statusCode, 500);
  assert.match(res.data.error, /Multiple active pricing rules/);
  assert.equal(res.data.total, undefined);
});

test("missing exact vehicle rate does not substitute another vehicle or region", async (t) => {
  t.mock.method(console, "error", () => {});
  let calls = 0;
  const res = await request({ ...payload, vehicleType: "cargo" }, {
    pool: { query: async (sql, params) => {
      calls++;
      assert.deepEqual(Array.from(params), ["oregon", "courier", "cargo"]);
      assert.doesNotMatch(sql, /\bOR\b|\bUNION\b/i);
      return { rows: [] };
    } },
  });
  assert.equal(calls, 1);
  assert.equal(res.statusCode, 500);
  assert.equal(res.data.total, undefined);
});

for (const [field, value, options] of [
  ["base_rate", undefined, {}],
  ["base_rate", null, {}],
  ["base_rate", "", {}],
  ["base_rate", "invalid", {}],
  ["per_mile_rate", -1, {}],
  ["per_mile_rate", Infinity, {}],
  ["priority_fee", null, { priority: true }],
  ["fragile_fee", undefined, { fragile: true }],
  ["time_sensitive_fee", undefined, { timeSensitive: true }],
  ["after_hours_fee", undefined, { afterHours: true }],
]) {
  test(`invalid ${field} (${String(value)}) prevents a quote before Google`, async (t) => {
    t.mock.method(console, "error", () => {});
    const network = t.mock.method(global, "fetch", async () => {
      assert.fail("no external lookup expected for incomplete pricing");
    });
    const res = await request({ ...payload, ...options }, {
      pool: { query: async () => ({ rows: [{ ...pricing, [field]: value }] }) },
    });
    assert.equal(res.statusCode, 500);
    assert.equal(res.data.error, `Quote pricing is not configured: ${field}`);
    assert.equal(res.data.total, undefined);
    assert.equal(network.mock.callCount(), 0);
  });
}

test("explicitly configured zero surcharge remains valid", async (t) => {
  stubGoogle(t);
  const res = await request({ ...payload, priority: true }, {
    pool: { query: async () => ({ rows: [{ ...pricing, priority_fee: "0" }] }) },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.data.breakdown.priority, 0);
  assert.equal(res.data.total, 35.13);
});

test("editing stored rates changes the next quote without changing code", async (t) => {
  stubGoogle(t);
  let currentRate = { ...pricing };
  let calls = 0;
  const pool = { query: async (_, params) => {
    calls++;
    assert.deepEqual(Array.from(params), ["oregon", "courier", "standard"]);
    return { rows: [currentRate] };
  } };
  const before = await request(payload, { pool });
  currentRate = { ...pricing, base_rate: "30.00", per_mile_rate: "3.00" };
  const after = await request(payload, { pool });
  assert.equal(before.data.total, 35.13);
  assert.equal(after.data.breakdown.baseFee, 30);
  assert.equal(after.data.breakdown.perMile, 3);
  assert.equal(after.data.breakdown.mileageCost, 13.5);
  assert.equal(after.data.total, 43.5);
  assert.equal(calls, 2);
});

test("stored extra fees can be changed without changing code", async (t) => {
  stubGoogle(t);
  let currentRate = { ...pricing, fragile_fee: "10.00", priority_fee: "15.00" };
  const pool = { query: async () => ({ rows: [currentRate] }) };
  const selected = { ...payload, fragile: true, priority: true };
  const before = await request(selected, { pool });
  currentRate = { ...currentRate, fragile_fee: "12.00", priority_fee: "18.00" };
  const after = await request(selected, { pool });
  assert.equal(before.data.total, 60.13);
  assert.equal(after.data.breakdown.fragile, 12);
  assert.equal(after.data.breakdown.priority, 18);
  assert.equal(after.data.total, 65.13);
});

test("Oregon Sedan mapping does not change another region's vehicle", async (t) => {
  stubGoogle(t);
  const res = await request({ ...payload, region: "washington" }, {
    pool: { query: async (_, params) => {
      assert.deepEqual(Array.from(params), ["washington", "courier", "sedan"]);
      return { rows: [pricing] };
    } },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.data.vehicleType, "sedan");
});
