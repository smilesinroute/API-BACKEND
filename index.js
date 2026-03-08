"use strict";

/*
Smiles In Route — Core API Router (Optimized Production)
========================================================

Plain Node.js HTTP server (NO Express)

Responsibilities
• Routing
• Quote generation
• Order creation
• Delegation to controllers
*/

const { URL } = require("url");
const crypto = require("crypto");

/* =====================================================
Controller Delegation
===================================================== */

const { handleOrders } = require("./src/controllers/ordersController");
const { handleAvailability } = require("./src/controllers/availabilityController");
const { handleAdminRoutes } = require("./src/admin/adminRoutes");

const { handleDriverLogin } = require("./src/drivers/driverLogin");
const { handleDriverRoutes } = require("./src/drivers/driverRoutes");
const { handleDriverOrders } = require("./src/drivers/driverOrders");
const { handleDriverAssignments } = require("./src/drivers/driverAssignments");
const { handleDriverProof } = require("./src/drivers/driverProof");

/* =====================================================
Response Helpers
===================================================== */

function json(res, status, payload) {
  if (res.writableEnded) return;

  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function text(res, status, message) {
  if (res.writableEnded) return;

  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(String(message || ""));
}

/* =====================================================
CORS
===================================================== */

const ALLOWED_ORIGINS = new Set([
  "https://smilesinroute.delivery",
  "https://www.smilesinroute.delivery",
  "https://admin.smilesinroute.delivery",
  "https://drivers.smilesinroute.delivery",
  "https://ops.smilesinroute.delivery",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

function applyCors(req, res) {
  const origin = req.headers.origin;

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Stripe-Signature"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,DELETE,OPTIONS"
  );
}

/* =====================================================
Body Parsing
===================================================== */

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {

    req.setTimeout(10000);

    let size = 0;
    const chunks = [];

    req.on("data", chunk => {

      size += chunk.length;

      if (size > limit) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", reject);
  });
}

async function readJson(req) {

  const type = String(req.headers["content-type"] || "");

  if (!type.includes("application/json")) {
    throw new Error("Content-Type must be application/json");
  }

  const raw = await readBody(req);

  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

/* =====================================================
Helpers
===================================================== */

function toStr(v) {
  return String(v ?? "").trim();
}

function toLower(v) {
  return toStr(v).toLowerCase();
}

function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  const x = toNumber(n, min);
  return Math.max(min, Math.min(max, x));
}

function toBool(v) {
  return v === true || v === "true" || v === 1 || v === "1";
}

function isValidEmail(email) {
  const e = toLower(email);
  return e.includes("@") && e.length >= 5;
}

/* =====================================================
Pricing Configuration
===================================================== */

const COURIER_PRICING = {

  regions: {

    oregon: {
      sedan: { base: 26, perMile: 2.35 },
      cargo: { base: 40, perMile: 3.25 }
    },

    texas: {
      sedan: { base: 28, perMile: 2.55 },
      cargo: { base: 42, perMile: 3.40 }
    },

    washington: {
      sedan: { base: 30, perMile: 2.75 },
      cargo: { base: 45, perMile: 3.60 }
    },

    default: {
      sedan: { base: 26, perMile: 2.35 },
      cargo: { base: 40, perMile: 3.25 }
    }
  },

  priorityFee: 20,
  fragileFee: 10,
  timeSensitiveFee: 15,
  minimumCharge: 35
};

/* =====================================================
Quote Builder
===================================================== */

function buildCourierQuote({
  miles,
  region,
  vehicle_type,
  fragile,
  priority,
  timeSensitive
}) {

  const reg =
    COURIER_PRICING.regions[region] ||
    COURIER_PRICING.regions.default;

  const vehicle = reg[vehicle_type] || reg.sedan;

  const base = toNumber(vehicle.base);
  const perMile = toNumber(vehicle.perMile);

  const dist = clamp(miles, 0, 5000);

  const mileage = Number((dist * perMile).toFixed(2));

  const fragileFee = fragile ? COURIER_PRICING.fragileFee : 0;
  const priorityFee = priority ? COURIER_PRICING.priorityFee : 0;
  const timeFee = timeSensitive ? COURIER_PRICING.timeSensitiveFee : 0;

  let total =
    base +
    mileage +
    fragileFee +
    priorityFee +
    timeFee;

  total = Number(
    Math.max(total, COURIER_PRICING.minimumCharge).toFixed(2)
  );

  return {
    breakdown: {
      base,
      mileage,
      fragile: fragileFee,
      priority: priorityFee,
      timeSensitive: timeFee,
      vehicle: vehicle_type,
      perMile
    },
    total
  };
}

/* =====================================================
Main Router
===================================================== */

async function handleAPI(req, res, pool) {

  applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  const method = String(req.method || "GET").toUpperCase();

  const parsed = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsed.pathname;

  try {

    /* HEALTH */

    if (pathname === "/api/health" && method === "GET") {

      await pool.query("SELECT 1");

      return json(res, 200, {
        status: "ok"
      });
    }

    /* QUOTE */

    if (pathname === "/api/quote" && method === "POST") {

      const body = await readJson(req);

      const miles = toNumber(body.distance_miles);

      const region = toLower(body.region) || "default";

      const vehicle_type = toLower(body.vehicle_type) || "sedan";

      const { breakdown, total } = buildCourierQuote({

        miles,
        region,
        vehicle_type,

        fragile: toBool(body.fragile),
        priority: toBool(body.priority),
        timeSensitive: toBool(body.timeSensitive)
      });

      return json(res, 200, {
        quote_id: crypto.randomUUID(),
        breakdown,
        total
      });
    }

    /* ORDER CREATION */

    if (pathname === "/api/orders" && method === "POST") {

      const body = await readJson(req);

      const service_type = toStr(body.service_type);
      const customer_name = toStr(body.customer_name);
      const customer_email = toLower(body.customer_email);

      if (!service_type)
        return json(res, 400, { error: "service_type required" });

      if (!customer_name)
        return json(res, 400, { error: "customer_name required" });

      if (!isValidEmail(customer_email))
        return json(res, 400, { error: "valid customer_email required" });

      const pickup_address = toStr(body.pickup_address);
      const delivery_address = toStr(body.delivery_address);

      const distance_miles =
        body.distance_miles === undefined
          ? null
          : clamp(body.distance_miles, 0, 5000);

      const total_amount = Number(
        toNumber(body.total_amount).toFixed(2)
      );

      const scheduled_date = toStr(body.scheduled_date) || null;
      const scheduled_time = toStr(body.scheduled_time) || null;

      const notes = toStr(body.notes) || null;

      const { rows } = await pool.query(
        `
        INSERT INTO orders (
          service_type,
          customer_name,
          customer_email,
          pickup_address,
          delivery_address,
          distance_miles,
          total_amount,
          scheduled_date,
          scheduled_time,
          notes,
          status,
          payment_status
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
          'pending_admin_review',
          'unpaid'
        )
        RETURNING *
        `,
        [
          service_type,
          customer_name,
          customer_email,
          pickup_address,
          delivery_address,
          distance_miles,
          total_amount,
          scheduled_date,
          scheduled_time,
          notes
        ]
      );

      return json(res, 201, rows[0]);
    }

    /* DRIVER */

    if (await handleDriverLogin(req, res, pool)) return;
    if (await handleDriverRoutes(req, res, pool, pathname, method)) return;
    if (await handleDriverOrders(req, res, pool, pathname, method)) return;
    if (await handleDriverAssignments(req, res, pool, pathname, method)) return;
    if (await handleDriverProof(req, res, pool, pathname, method)) return;

    /* ADMIN */

    if (await handleAdminRoutes(req, res, pool, pathname, method, json)) return;

    /* LEGACY */

    if (await handleAvailability(req, res, pool, pathname, method, json)) return;
    if (await handleOrders(req, res, pool, pathname, method, json)) return;

    /* ROOT */

    if (pathname === "/" && method === "GET") {
      return text(res, 200, "Smiles In Route API");
    }

    return json(res, 404, { error: "Not found" });

  } catch (err) {

    console.error("[API ERROR]", err);

    return json(res, 500, {
      error: "Server error"
    });
  }
}

module.exports = { handleAPI };