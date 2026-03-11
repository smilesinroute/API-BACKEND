
"use strict";

/*
Smiles In Route — Platform API
==============================

Core backend API for:
- Customer Portal
- Ops Portal
- Driver Portal
- Admin workflows

Architecture:
- Native Node HTTP
- PostgreSQL
- Controller based routing
*/

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
      "http://127.0.0.1:5173",
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
BODY PARSING
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
VALIDATION HELPERS
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
    texas: { base: 28, perMile: 2.55 },
    oregon: { base: 26, perMile: 2.35 },
    washington: { base: 30, perMile: 2.75 },
    default: { base: 26, perMile: 2.35 }
  },

  minimumCharge: 35
};

function buildCourierQuote({ miles, region }) {

  const pricing = COURIER_PRICING.regions[region] ||
                  COURIER_PRICING.regions.default;

  const distance = clamp(miles, 0, 5000);

  const total = Math.max(
    pricing.base + distance * pricing.perMile,
    COURIER_PRICING.minimumCharge
  );

  return {
    breakdown: {
      service_type: "courier",
      region,
      distance_miles: distance,
      base: pricing.base,
      perMile: pricing.perMile
    },
    total
  };
}

/* ===============================
NOTARY PRICING
=============================== */

const NOTARY_PRICING = {
  regions: {
    texas: { base: 95, extraSignerFee: 20 },
    oregon: { base: 85, extraSignerFee: 15 },
    washington: { base: 105, extraSignerFee: 20 },
    default: { base: 85, extraSignerFee: 15 }
  }
};

function buildNotaryQuote({ region, signers }) {

  const pricing = NOTARY_PRICING.regions[region] ||
                  NOTARY_PRICING.regions.default;

  const signerCount = clamp(signers, 1, 20);

  const extra = Math.max(0, signerCount - 1) * pricing.extraSignerFee;

  return {
    breakdown: {
      service_type: "notary",
      region,
      signers: signerCount
    },
    total: pricing.base + extra
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
  const pathname = parsed.pathname;

  try {

    /* ===============================
    HEALTH
    =============================== */

    if (pathname === "/api/health" && method === "GET") {
      await pool.query("SELECT 1");
      return json(res, 200, { status: "ok" });
    }

    /* ===============================
    COURIER QUOTE
    =============================== */

    if (pathname === "/api/quote" && method === "POST") {

      const body = await readJson(req);

      if (!body.distance_miles) {
        return badRequest(res, "distance_miles required");
      }

      const region = toLower(body.region) || "default";

      const quote = buildCourierQuote({
        miles: body.distance_miles,
        region
      });

      return json(res, 200, {
        quote_id: crypto.randomUUID(),
        ...quote
      });
    }

    /* ===============================
    NOTARY QUOTE
    =============================== */

    if (pathname === "/api/notary/quote" && method === "POST") {

      const body = await readJson(req);

      if (!body.signers) {
        return badRequest(res, "signers required");
      }

      const region = toLower(body.region) || "default";

      const quote = buildNotaryQuote({
        region,
        signers: body.signers
      });

      return json(res, 200, {
        quote_id: crypto.randomUUID(),
        ...quote
      });
    }

    /* ===============================
    DRIVER ROUTES
    =============================== */

    if (await handleDriverLogin(req, res, pool)) return;
    if (await handleDriverRoutes(req, res, pool, pathname, method)) return;
    if (await handleDriverOrders(req, res, pool, pathname, method)) return;
    if (await handleDriverAssignments(req, res, pool, pathname, method)) return;
    if (await handleDriverProof(req, res, pool, pathname, method)) return;

    /* ===============================
    ADMIN ROUTES
    =============================== */

    if (await handleAdminRoutes(req, res, pool, pathname, method, json)) return;

    /* ===============================
    ORDERS CONTROLLER
    =============================== */

    if (await handleOrders(req, res, pool, pathname, method, json)) return;

    /* ===============================
    AVAILABILITY
    =============================== */

    if (await handleAvailability(req, res, pool, pathname, method, json)) return;

    /* ===============================
    ROOT
    =============================== */

    if (pathname === "/" && method === "GET") {
      return text(res, 200, "Smiles In Route Platform API");
    }

    return json(res, 404, { error: "Not found" });

  } catch (err) {

    console.error("[PLATFORM API ERROR]", err);

    return json(res, 500, {
      error: "Server error"
    });
  }
}

module.exports = { handleAPI };