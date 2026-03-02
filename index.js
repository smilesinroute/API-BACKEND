"use strict";

/**
 * Smiles In Route — Core API Router (Production)
 * ==============================================
 * - Plain Node.js HTTP (NO Express)
 * - Strict credential-safe CORS
 * - Courier + Notary unified under orders table
 * - Region + vehicle-aware instant quotes
 * - Admin review required before payment (status: pending_admin_review)
 *
 * Endpoints in this file:
 * - GET  /api/health
 * - POST /api/quote                (courier quote)
 * - POST /api/notary/quote         (notary quote)
 * - POST /api/orders               (unified order submission)
 */

const url = require("url");
const crypto = require("crypto");

/* ======================================================
   Controllers (delegated routes)
====================================================== */
const { handleOrders } = require("./src/controllers/ordersController");
const { handleAvailability } = require("./src/controllers/availabilityController");
const { handleAdminRoutes } = require("./src/admin/adminRoutes");

const { handleDriverLogin } = require("./src/drivers/driverLogin");
const { handleDriverRoutes } = require("./src/drivers/driverRoutes");
const { handleDriverOrders } = require("./src/drivers/driverOrders");
const { handleDriverAssignments } = require("./src/drivers/driverAssignments");
const { handleDriverProof } = require("./src/drivers/driverProof");

/* ======================================================
   Response helpers
====================================================== */
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

/* ======================================================
   Strict CORS
====================================================== */
const ALLOWED_ORIGINS = new Set([
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
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
}

/* ======================================================
   Body parsing
====================================================== */
function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
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

    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const type = String(req.headers["content-type"] || "");
  if (type && !type.includes("application/json")) {
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

/* ======================================================
   Validation helpers
====================================================== */
function toStr(value) {
  return String(value ?? "").trim();
}

function toLower(value) {
  return toStr(value).toLowerCase();
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isValidEmail(value) {
  const email = toLower(value);
  return email.includes("@") && email.length >= 5;
}

function clamp(n, min, max) {
  const x = toNumber(n, min);
  return Math.max(min, Math.min(max, x));
}

/* ======================================================
   Region logic
   - matches your frontend zip logic
====================================================== */
function getRegionByZip(zip) {
  const z = toStr(zip);
  if (/^97/.test(z)) return "oregon";
  if (/^77/.test(z)) return "texas";
  if (/^98/.test(z)) return "washington";
  return "unsupported";
}

/* ======================================================
   Pricing Config (Courier + Notary)
   - Designed for easy region tuning
====================================================== */
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

const NOTARY_PRICING = {
  regions: {
    oregon: {
      travelBase: 35,
      signerFee: 15,
      documentFee: 5, // per document
      realEstateFee: 25,
      timeSensitiveFee: 20,
      minimumCharge: 60,
    },
    texas: {
      travelBase: 40,
      signerFee: 18,
      documentFee: 6,
      realEstateFee: 30,
      timeSensitiveFee: 25,
      minimumCharge: 70,
    },
    washington: {
      travelBase: 45,
      signerFee: 20,
      documentFee: 7,
      realEstateFee: 35,
      timeSensitiveFee: 25,
      minimumCharge: 75,
    },
    default: {
      travelBase: 35,
      signerFee: 15,
      documentFee: 5,
      realEstateFee: 25,
      timeSensitiveFee: 20,
      minimumCharge: 60,
    },
  },
};

/* ======================================================
   Quote Builders (Production)
====================================================== */
function buildCourierQuote({
  miles,
  region,
  vehicle_type,
  fragile,
  priority,
  timeSensitive,
}) {
  const reg =
    COURIER_PRICING.regions[region] || COURIER_PRICING.regions.default;

  const vType = vehicle_type === "cargo" ? "cargo" : "sedan";
  const vehicle = reg[vType] || reg.sedan;

  const base = toNumber(vehicle.base, 0);
  const perMile = toNumber(vehicle.perMile, 0);

  const dist = clamp(miles, 0, 5000);
  const mileage = Number((dist * perMile).toFixed(2));

  const fragileFee = fragile ? COURIER_PRICING.fragileFee : 0;
  const priorityFee = priority ? COURIER_PRICING.priorityFee : 0;
  const timeSensitiveFee = timeSensitive ? COURIER_PRICING.timeSensitiveFee : 0;

  let total = base + mileage + fragileFee + priorityFee + timeSensitiveFee;
  total = Number(Math.max(total, COURIER_PRICING.minimumCharge).toFixed(2));

  return {
    breakdown: {
      base,
      mileage,
      fragile: fragileFee,
      priority: priorityFee,
      timeSensitive: timeSensitiveFee,
      vehicle: vType,
      perMile,
    },
    total,
  };
}

function buildNotaryQuote({
  region,
  document_type,
  signers,
  documentsCount,
  timeSensitive,
}) {
  const reg =
    NOTARY_PRICING.regions[region] || NOTARY_PRICING.regions.default;

  const travelBase = toNumber(reg.travelBase, 0);
  const signerFeeUnit = toNumber(reg.signerFee, 0);
  const documentFeeUnit = toNumber(reg.documentFee, 0);
  const realEstateFeeUnit = toNumber(reg.realEstateFee, 0);
  const timeSensitiveFeeUnit = toNumber(reg.timeSensitiveFee, 0);

  const s = clamp(signers, 1, 25);
  const d = clamp(documentsCount, 1, 50);

  const signerFee = signerFeeUnit * s;
  const documentFee = documentFeeUnit * d;

  const docType = toStr(document_type);
  const isRealEstate =
    docType.toLowerCase().includes("real estate") || docType === "Real estate";

  const realEstateFee = isRealEstate ? realEstateFeeUnit : 0;
  const timeFee = timeSensitive ? timeSensitiveFeeUnit : 0;

  let total = travelBase + signerFee + documentFee + realEstateFee + timeFee;
  total = Number(Math.max(total, reg.minimumCharge || 0).toFixed(2));

  return {
    breakdown: {
      travelBase,
      signerFee,
      documentFee,
      realEstateFee,
      timeSensitive: timeFee,
      signers: s,
      documents: d,
      document_type: docType || "General document",
    },
    total,
  };
}

/* ======================================================
   Main Router
====================================================== */
async function handleAPI(req, res, pool) {
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  const method = String(req.method || "GET").toUpperCase();
  const parsed = url.parse(String(req.url || "/"), true);
  const pathname = parsed.pathname || "/";

  try {
    /* ================= HEALTH ================= */
    if (pathname === "/api/health" && method === "GET") {
      await pool.query("SELECT 1");
      return json(res, 200, { status: "ok" });
    }

    /* ================= COURIER QUOTE =================
       POST /api/quote
       Expected:
       - region (optional but recommended)
       - distance_miles
       - vehicle_type: "sedan" | "cargo"
       - fragile/priority/timeSensitive (optional)
    */
    if (pathname === "/api/quote" && method === "POST") {
      const body = await readJson(req);

      const region = toStr(body.region) || "default";
      const miles = toNumber(body.distance_miles, 0);

      const vehicle_type = toStr(body.vehicle_type) || "sedan";

      const { breakdown, total } = buildCourierQuote({
        miles,
        region,
        vehicle_type,
        fragile: Boolean(body.fragile),
        priority: Boolean(body.priority),
        timeSensitive: Boolean(body.timeSensitive),
      });

      return json(res, 200, {
        quote_id: crypto.randomUUID(),
        breakdown,
        total,
      });
    }

    /* ================= NOTARY QUOTE =================
       POST /api/notary/quote
       Expected:
       - region (required)
       - document_type (required)
       - signers (required)
       - documentsCount (optional, defaults to 1)
       - timeSensitive (optional)
    */
    if (pathname === "/api/notary/quote" && method === "POST") {
      const body = await readJson(req);

      const region = toStr(body.region);
      if (!region) {
        return json(res, 400, { error: "region is required" });
      }
      if (region === "unsupported") {
        return json(res, 400, { error: "Service not available in this region" });
      }

      const document_type = toStr(body.document_type);
      const signers = toNumber(body.signers, 1);

      if (!document_type) {
        return json(res, 400, { error: "document_type is required" });
      }
      if (signers < 1) {
        return json(res, 400, { error: "signers must be >= 1" });
      }

      const documentsCount = toNumber(body.documentsCount, 1);

      const { breakdown, total } = buildNotaryQuote({
        region,
        document_type,
        signers,
        documentsCount,
        timeSensitive: Boolean(body.timeSensitive),
      });

      return json(res, 200, {
        quote_id: crypto.randomUUID(),
        breakdown,
        total,
      });
    }

    /* ================= UNIFIED ORDER SUBMISSION =================
       POST /api/orders

       Common:
       - service_type: "courier" | "notary"
       - customer_email
       - region (recommended)
       - scheduled_date, scheduled_time (recommended)

       Courier expects:
       - pickup_address, delivery_address, distance_miles
       - total_amount (from quote)

       Notary expects:
       - pickup_address (signing address)
       - id_address (address on ID)
       - total_amount (from quote)
       - notes optional
       NOTE: notary-specific fields like doc type/signers can be stored
             in notes or you can add columns later. This keeps DB stable today.
    */
    if (pathname === "/api/orders" && method === "POST") {
      const body = await readJson(req);

      const service_type = toStr(body.service_type);
      const customer_email = toLower(body.customer_email);

      if (!service_type || !["courier", "notary"].includes(service_type)) {
        return json(res, 400, { error: "service_type must be courier or notary" });
      }
      if (!isValidEmail(customer_email)) {
        return json(res, 400, { error: "Valid customer_email is required" });
      }

      const region = toStr(body.region) || null;

      // Basic schedule sanity (allow nulls but keep it consistent)
      const scheduled_date = toStr(body.scheduled_date) || null; // YYYY-MM-DD
      const scheduled_time = toStr(body.scheduled_time) || null; // "09:00 AM" or "HH:MM"

      const pickup_address = toStr(body.pickup_address) || null;
      const delivery_address = toStr(body.delivery_address) || null;
      const id_address = toStr(body.id_address) || null;

      const distance_miles =
        body.distance_miles === undefined || body.distance_miles === null
          ? null
          : clamp(body.distance_miles, 0, 5000);

      const total_amount = Number(toNumber(body.total_amount, 0).toFixed(2));
      if (total_amount <= 0) {
        return json(res, 400, { error: "total_amount must be > 0" });
      }

      // Service-specific validation
      if (service_type === "courier") {
        if (!pickup_address || !delivery_address) {
          return json(res, 400, {
            error: "pickup_address and delivery_address are required for courier",
          });
        }
        if (distance_miles === null) {
          return json(res, 400, {
            error: "distance_miles is required for courier",
          });
        }
      }

      if (service_type === "notary") {
        if (!pickup_address) {
          return json(res, 400, {
            error: "pickup_address (signing address) is required for notary",
          });
        }
        if (!id_address) {
          return json(res, 400, {
            error: "id_address (address on ID) is required for notary",
          });
        }
      }

      const notes = toStr(body.notes) || null;

      const { rows } = await pool.query(
        `
        INSERT INTO orders (
          service_type,
          region,
          customer_email,
          pickup_address,
          id_address,
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
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
          'pending_admin_review',
          'unpaid'
        )
        RETURNING *
        `,
        [
          service_type,
          region,
          customer_email,
          pickup_address,
          id_address,
          delivery_address,
          distance_miles,
          total_amount,
          scheduled_date,
          scheduled_time,
          notes,
        ]
      );

      return json(res, 201, rows[0]);
    }

    /* ================= DRIVER ================= */
    if (await handleDriverLogin(req, res, pool)) return;
    if (await handleDriverRoutes(req, res, pool, pathname, method)) return;
    if (await handleDriverOrders(req, res, pool, pathname, method)) return;
    if (await handleDriverAssignments(req, res, pool, pathname, method)) return;
    if (await handleDriverProof(req, res, pool, pathname, method)) return;

    /* ================= ADMIN ================= */
    if (await handleAdminRoutes(req, res, pool, pathname, method, json)) return;

    /* ================= PUBLIC (legacy controllers) ================= */
    if (await handleAvailability(req, res, pool, pathname, method, json)) return;
    if (await handleOrders(req, res, pool, pathname, method, json)) return;

    if (pathname === "/" && method === "GET") {
      return text(res, 200, "Smiles In Route API");
    }

    return json(res, 404, { error: "Not found" });
  } catch (err) {
    console.error("[API ROUTER ERROR]", err);
    return json(res, 500, { error: err.message || "Server error" });
  }
}

module.exports = { handleAPI };