
"use strict";

const { URL } = require("url");
const crypto = require("crypto");

/* ===============================
   CONTROLLERS
=============================== */

const { handleOrders } = require("./src/controllers/ordersController");
const { handleAvailability } = require("./src/controllers/availabilityController");
const { handleAdminRoutes } = require("./src/admin/adminRoutes");

const { handleDriverLogin } = require("./src/drivers/driverLogin");
const { handleDriverRoutes } = require("./src/drivers/driverRoutes");
const { handleDriverOrders } = require("./src/drivers/driverOrders");
const { handleDriverAssignments } = require("./src/drivers/driverAssignments");
const { handleDriverProof } = require("./src/drivers/driverProof");

/* ===============================
   RESPONSE HELPERS
=============================== */

function json(res, status, payload) {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function text(res, status, message) {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain");
  res.end(String(message || ""));
}

function badRequest(res, message) {
  return json(res, 400, { error: message });
}

/* ===============================
   CORS
=============================== */

function parseAllowedOrigins() {

  const raw = String(process.env.CORS_ALLOWED_ORIGINS || "").trim();

  if (!raw) {
    return new Set([
      "https://smilesinroute.delivery",
      "https://www.smilesinroute.delivery",
      "https://admin.smilesinroute.delivery",
      "https://drivers.smilesinroute.delivery",
      "https://ops.smilesinroute.delivery",
      "http://localhost:5173",
      "http://127.0.0.1:5173"
    ]);
  }

  return new Set(raw.split(",").map(v => v.trim()));
}

const ALLOWED_ORIGINS = parseAllowedOrigins();

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

/* ===============================
   BODY PARSER
=============================== */

async function readBody(req) {

  let body = "";

  for await (const chunk of req) {
    body += chunk;
  }

  return body;
}

async function readJson(req) {

  const raw = await readBody(req);

  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

/* ===============================
   HELPERS
=============================== */

function toLower(v) {
  return String(v || "").trim().toLowerCase();
}

function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  const x = toNumber(n, min);
  return Math.max(min, Math.min(max, x));
}

/* ===============================
   COURIER PRICING
=============================== */

const COURIER_PRICING = {

  regions: {

    texas: {
      sedan: { base: 28, perMile: 2.55 },
      cargo: { base: 42, perMile: 3.40 }
    },

    oregon: {
      sedan: { base: 26, perMile: 2.35 },
      cargo: { base: 40, perMile: 3.25 }
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

  addons: {
    fragile: 10,
    priority: 20,
    timeSensitive: 15
  },

  minimumCharge: 35

};

function buildCourierQuote({
  miles,
  region,
  vehicle_type,
  fragile,
  priority,
  timeSensitive
}) {

  const regionPricing =
    COURIER_PRICING.regions[region] ||
    COURIER_PRICING.regions.default;

  const vehiclePricing =
    regionPricing[vehicle_type] ||
    regionPricing.sedan;

  const distance = clamp(miles, 0, 5000);

  const mileage = distance * vehiclePricing.perMile;

  const fragileFee = fragile ? COURIER_PRICING.addons.fragile : 0;
  const priorityFee = priority ? COURIER_PRICING.addons.priority : 0;
  const timeFee = timeSensitive ? COURIER_PRICING.addons.timeSensitive : 0;

  const subtotal =
    vehiclePricing.base +
    mileage +
    fragileFee +
    priorityFee +
    timeFee;

  const total = Math.max(subtotal, COURIER_PRICING.minimumCharge);

  return {

    breakdown: {
      service_type: "courier",
      region,
      vehicle_type,
      distance_miles: distance,
      base: vehiclePricing.base,
      perMile: vehiclePricing.perMile,
      mileage: Number(mileage.toFixed(2)),
      fragile: fragileFee,
      priority: priorityFee,
      timeSensitive: timeFee
    },

    total: Number(total.toFixed(2))
  };

}

/* ===============================
   MAIN ROUTER
=============================== */

async function handleAPI(req, res, pool) {

  applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  const method = req.method;

  const parsed = new URL(req.url, `http://${req.headers.host}`);

  let pathname = parsed.pathname;

  /* Normalize /api prefix so internal routers work */
  if (pathname.startsWith("/api/")) {
    pathname = pathname.slice(4);
  }

  try {

    /* HEALTH */

    if (pathname === "/health" && method === "GET") {

      await pool.query("SELECT 1");

      return json(res, 200, { status: "ok" });
    }

    /* DRIVER ROUTES */

    if (await handleDriverLogin(req, res, pool)) return;
    if (await handleDriverRoutes(req, res, pool, pathname, method)) return;
    if (await handleDriverOrders(req, res, pool, pathname, method)) return;
    if (await handleDriverAssignments(req, res, pool, pathname, method)) return;
    if (await handleDriverProof(req, res, pool, pathname, method)) return;

    /* ADMIN ROUTES */

    if (await handleAdminRoutes(req, res, pool, pathname, method, json)) return;

    /* ORDERS */

    if (await handleOrders(req, res, pool, pathname, method, json)) return;

    /* AVAILABILITY */

    if (await handleAvailability(req, res, pool, pathname, method, json)) return;

    /* ROOT */

    if (pathname === "/" && method === "GET") {
      return text(res, 200, "Smiles In Route Platform API");
    }

    return json(res, 404, { error: "Not found" });

  } catch (err) {

    console.error("[PLATFORM API ERROR]", err);

    return json(res, 500, { error: "Server error" });

  }
}

module.exports = { handleAPI };