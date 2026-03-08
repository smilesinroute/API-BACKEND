"use strict";

/*
Smiles In Route — Platform API
==============================

Core backend API for:
- Customer Portal
- Ops Portal
- Driver Portal
- Admin workflows

Responsibilities:
- Pricing logic
- Availability
- Unified order creation
- Order lifecycle management
- Driver assignment
- Admin review

Architecture:
- Node.js native HTTP (no Express)
- PostgreSQL
- Strict CORS
- Unified orders table
- Role-based access through internal handlers
*/

const { URL } = require("url");
const crypto = require("crypto");

/* =========================================================
Controller Delegation
========================================================= */

const { handleOrders } = require("./src/controllers/ordersController");
const { handleAvailability } = require("./src/controllers/availabilityController");
const { handleAdminRoutes } = require("./src/admin/adminRoutes");

const { handleDriverLogin } = require("./src/drivers/driverLogin");
const { handleDriverRoutes } = require("./src/drivers/driverRoutes");
const { handleDriverOrders } = require("./src/drivers/driverOrders");
const { handleDriverAssignments } = require("./src/drivers/driverAssignments");
const { handleDriverProof } = require("./src/drivers/driverProof");

/* =========================================================
Response Helpers
========================================================= */

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

function badRequest(res, message, extra = undefined) {
  return json(res, 400, extra ? { error: message, ...extra } : { error: message });
}

/* =========================================================
CORS
========================================================= */

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
      "http://localhost:5174",
      "http://localhost:5175",
      "http://localhost:5176",
      "http://localhost:5177",
      "http://127.0.0.1:5173",
    ]);
  }

  return new Set(
    raw
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
  );
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

/* =========================================================
Body Parsing
========================================================= */

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    req.setTimeout(10_000);

    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
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
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
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

/* =========================================================
Validation Helpers
========================================================= */

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

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isValidEmail(email) {
  const e = toLower(email);
  return e.includes("@") && e.length >= 5;
}

function roundMoney(n) {
  return Number(toNumber(n, 0).toFixed(2));
}

function moneyEqual(a, b) {
  return Math.abs(roundMoney(a) - roundMoney(b)) < 0.01;
}

/* =========================================================
Pricing Config — Courier
========================================================= */

const COURIER_PRICING = {
  regions: {
    oregon: {
      sedan: { base: 26, perMile: 2.35 },
      cargo: { base: 40, perMile: 3.25 },
    },
    texas: {
      sedan: { base: 28, perMile: 2.55 },
      cargo: { base: 42, perMile: 3.4 },
    },
    washington: {
      sedan: { base: 30, perMile: 2.75 },
      cargo: { base: 45, perMile: 3.6 },
    },
    default: {
      sedan: { base: 26, perMile: 2.35 },
      cargo: { base: 40, perMile: 3.25 },
    },
  },

  priorityFee: 20,
  fragileFee: 10,
  timeSensitiveFee: 15,
  minimumCharge: 35,
};

/* =========================================================
Pricing Config — Notary
========================================================= */

const NOTARY_PRICING = {
  regions: {
    oregon: {
      base: 85,
      extraSignerFee: 15,
    },
    texas: {
      base: 95,
      extraSignerFee: 20,
    },
    washington: {
      base: 105,
      extraSignerFee: 20,
    },
    default: {
      base: 85,
      extraSignerFee: 15,
    },
  },

  documentTypes: {
    standard: 0,
    loan: 75,
    real_estate: 60,
    affidavit: 10,
    power_of_attorney: 25,
    trust: 40,
    default: 0,
  },

  minimumCharge: 85,
};

/* =========================================================
Quote Builders
========================================================= */

function buildCourierQuote({
  miles,
  region,
  vehicle_type,
  fragile,
  priority,
  timeSensitive,
}) {
  const reg = COURIER_PRICING.regions[region] || COURIER_PRICING.regions.default;
  const vehicle = reg[vehicle_type] || reg.sedan;

  const base = toNumber(vehicle.base);
  const perMile = toNumber(vehicle.perMile);

  const dist = clamp(miles, 0, 5000);
  const mileage = roundMoney(dist * perMile);

  const fragileFee = fragile ? COURIER_PRICING.fragileFee : 0;
  const priorityFee = priority ? COURIER_PRICING.priorityFee : 0;
  const timeFee = timeSensitive ? COURIER_PRICING.timeSensitiveFee : 0;

  const total = roundMoney(
    Math.max(
      base + mileage + fragileFee + priorityFee + timeFee,
      COURIER_PRICING.minimumCharge
    )
  );

  return {
    breakdown: {
      service_type: "courier",
      region,
      distance_miles: dist,
      base,
      mileage,
      fragile: fragileFee,
      priority: priorityFee,
      timeSensitive: timeFee,
      vehicle: vehicle_type,
      perMile,
    },
    total,
  };
}

function buildNotaryQuote({
  region,
  signers,
  document_type,
}) {
  const reg = NOTARY_PRICING.regions[region] || NOTARY_PRICING.regions.default;
  const normalizedDoc = toLower(document_type) || "standard";
  const normalizedSigners = clamp(signers, 1, 20);

  const base = toNumber(reg.base);
  const extraSignerCount = Math.max(0, normalizedSigners - 1);
  const extraSignerFee = roundMoney(extraSignerCount * toNumber(reg.extraSignerFee));

  const documentFee = roundMoney(
    NOTARY_PRICING.documentTypes[normalizedDoc] ??
      NOTARY_PRICING.documentTypes.default
  );

  const total = roundMoney(
    Math.max(base + extraSignerFee + documentFee, NOTARY_PRICING.minimumCharge)
  );

  return {
    breakdown: {
      service_type: "notary",
      region,
      signers: normalizedSigners,
      document_type: normalizedDoc,
      base,
      extraSigners: extraSignerFee,
      documentFee,
    },
    total,
  };
}

/* =========================================================
Order Payload Normalization
========================================================= */

function normalizeCourierOrder(body) {
  const region = toLower(body.region) || "default";
  const vehicle_type = toLower(body.vehicle_type) || "sedan";

  const quote = buildCourierQuote({
    miles: body.distance_miles,
    region,
    vehicle_type,
    fragile: toBool(body.fragile),
    priority: toBool(body.priority),
    timeSensitive: toBool(body.timeSensitive),
  });

  return {
    region,
    quote,
    orderFields: {
      pickup_address: toStr(body.pickup_address) || null,
      delivery_address: toStr(body.delivery_address) || null,
      id_address: null,
      distance_miles:
        body.distance_miles === undefined ? null : clamp(body.distance_miles, 0, 5000),
      signers: null,
      document_type: null,
      vehicle_type,
      pricing_breakdown: quote.breakdown,
    },
  };
}

function normalizeNotaryOrder(body) {
  const region = toLower(body.region) || "default";

  const quote = buildNotaryQuote({
    region,
    signers: body.signers,
    document_type: body.document_type,
  });

  return {
    region,
    quote,
    orderFields: {
      pickup_address: null,
      delivery_address: null,
      id_address: toStr(body.id_address) || null,
      distance_miles: null,
      signers: clamp(body.signers, 1, 20),
      document_type: toLower(body.document_type) || "standard",
      vehicle_type: null,
      pricing_breakdown: quote.breakdown,
    },
  };
}

/* =========================================================
Main Router
========================================================= */

async function handleAPI(req, res, pool) {
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  const method = String(req.method || "GET").toUpperCase();
  const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = parsed.pathname;

  try {
    /* HEALTH */

    if (pathname === "/api/health" && method === "GET") {
      await pool.query("SELECT 1");
      return json(res, 200, { status: "ok" });
    }

    /* COURIER QUOTE */

    if (pathname === "/api/quote" && method === "POST") {
      const body = await readJson(req);

      if (body.distance_miles === undefined) {
        return badRequest(res, "distance_miles is required");
      }

      const region = toLower(body.region) || "default";
      const vehicle_type = toLower(body.vehicle_type) || "sedan";

      const { breakdown, total } = buildCourierQuote({
        miles: body.distance_miles,
        region,
        vehicle_type,
        fragile: toBool(body.fragile),
        priority: toBool(body.priority),
        timeSensitive: toBool(body.timeSensitive),
      });

      return json(res, 200, {
        quote_id: crypto.randomUUID(),
        breakdown,
        total,
      });
    }

    /* NOTARY QUOTE */

    if (pathname === "/api/notary/quote" && method === "POST") {
      const body = await readJson(req);

      if (body.signers === undefined) {
        return badRequest(res, "signers is required");
      }

      const region = toLower(body.region) || "default";
      const document_type = toLower(body.document_type) || "standard";

      const { breakdown, total } = buildNotaryQuote({
        region,
        signers: body.signers,
        document_type,
      });

      return json(res, 200, {
        quote_id: crypto.randomUUID(),
        breakdown,
        total,
      });
    }

    /* UNIFIED ORDER SUBMISSION */

    if (pathname === "/api/orders" && method === "POST") {
      const body = await readJson(req);

      const service_type = toLower(body.service_type);
      const customer_email = toLower(body.customer_email);
      const customer_name = toStr(body.customer_name) || null;

      if (service_type !== "courier" && service_type !== "notary") {
        return badRequest(res, "service_type must be courier or notary");
      }

      if (!isValidEmail(customer_email)) {
        return badRequest(res, "Valid customer_email is required");
      }

      if (body.total_amount === undefined) {
        return badRequest(res, "total_amount is required");
      }

      if (
        body.pricing_breakdown !== undefined &&
        body.pricing_breakdown !== null &&
        !isPlainObject(body.pricing_breakdown)
      ) {
        return badRequest(res, "pricing_breakdown must be an object");
      }

      let normalized;

      if (service_type === "courier") {
        if (!toStr(body.pickup_address)) {
          return badRequest(res, "pickup_address is required for courier");
        }

        if (!toStr(body.delivery_address)) {
          return badRequest(res, "delivery_address is required for courier");
        }

        if (body.distance_miles === undefined) {
          return badRequest(res, "distance_miles is required for courier");
        }

        normalized = normalizeCourierOrder(body);
      } else {
        if (body.signers === undefined) {
          return badRequest(res, "signers is required for notary");
        }

        normalized = normalizeNotaryOrder(body);
      }

      const serverTotal = normalized.quote.total;
      const clientTotal = roundMoney(body.total_amount);

      if (!moneyEqual(serverTotal, clientTotal)) {
        return badRequest(res, "total_amount does not match server pricing", {
          expected_total: serverTotal,
        });
      }

      const pricing_breakdown = normalized.orderFields.pricing_breakdown;
      const region = normalized.region || null;

      const pickup_address = normalized.orderFields.pickup_address;
      const delivery_address = normalized.orderFields.delivery_address;
      const id_address = normalized.orderFields.id_address;
      const distance_miles = normalized.orderFields.distance_miles;
      const signers = normalized.orderFields.signers;
      const document_type = normalized.orderFields.document_type;
      const vehicle_type = normalized.orderFields.vehicle_type;

      const scheduled_date = toStr(body.scheduled_date) || null;
      const scheduled_time = toStr(body.scheduled_time) || null;
      const notes = toStr(body.notes) || null;

      const { rows } = await pool.query(
        `
        INSERT INTO orders (
          service_type,
          region,
          customer_name,
          customer_email,
          pickup_address,
          delivery_address,
          id_address,
          distance_miles,
          signers,
          document_type,
          vehicle_type,
          scheduled_date,
          scheduled_time,
          total_amount,
          notes,
          pricing_breakdown,
          status,
          payment_status
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
          'pending_admin_review',
          'unpaid'
        )
        RETURNING *
        `,
        [
          service_type,
          region,
          customer_name,
          customer_email,
          pickup_address,
          delivery_address,
          id_address,
          distance_miles,
          signers,
          document_type,
          vehicle_type,
          scheduled_date,
          scheduled_time,
          serverTotal,
          notes,
          JSON.stringify(pricing_breakdown),
        ]
      );

      return json(res, 201, rows[0]);
    }

    /* DRIVER ROUTES */

    if (await handleDriverLogin(req, res, pool)) return;
    if (await handleDriverRoutes(req, res, pool, pathname, method)) return;
    if (await handleDriverOrders(req, res, pool, pathname, method)) return;
    if (await handleDriverAssignments(req, res, pool, pathname, method)) return;
    if (await handleDriverProof(req, res, pool, pathname, method)) return;

    /* ADMIN ROUTES */

    if (await handleAdminRoutes(req, res, pool, pathname, method, json)) return;

    /* LEGACY / INTERNAL CONTROLLERS */

    if (await handleAvailability(req, res, pool, pathname, method, json)) return;
    if (await handleOrders(req, res, pool, pathname, method, json)) return;

    /* ROOT */

    if (pathname === "/" && method === "GET") {
      return text(res, 200, "Smiles In Route Platform API");
    }

    return json(res, 404, { error: "Not found" });
  } catch (err) {
    console.error("[PLATFORM API ERROR]", err);

    const message = err && err.message ? err.message : "Server error";

    if (
      message === "Invalid JSON body" ||
      message === "Content-Type must be application/json" ||
      message === "Request body too large" ||
      message === "Request timed out"
    ) {
      return badRequest(res, message);
    }

    return json(res, 500, { error: "Server error" });
  }
}

module.exports = { handleAPI };