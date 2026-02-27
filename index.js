"use strict";

/**
 * Smiles In Route — Core API Router
 * ==================================
 * - Plain Node.js HTTP (NO Express)
 * - Strict credential-safe CORS
 * - Courier + Notary unified under orders table
 * - Instant quote support for both services
 */

const url = require("url");
const crypto = require("crypto");

/* ======================================================
   Controllers
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
   RESPONSE HELPERS
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
   STRICT CORS
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

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,DELETE,OPTIONS"
  );
}

/* ======================================================
   BODY PARSING
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

    req.on("end", () =>
      resolve(Buffer.concat(chunks).toString("utf8"))
    );

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
   QUOTE BUILDERS
====================================================== */
function buildCourierQuote({ miles }) {
  const base = 25;
  const mileage = Number((Number(miles || 0) * 2.25).toFixed(2));
  const total = base + mileage;

  return {
    breakdown: { base, mileage },
    total,
  };
}

function buildNotaryQuote({ signers, document_type }) {
  const travelBase = 35;
  const signerFee = 15 * Number(signers || 1);
  const realEstateFee =
    document_type === "Real estate" ? 25 : 0;

  const total = travelBase + signerFee + realEstateFee;

  return {
    breakdown: {
      travelBase,
      signerFee,
      realEstateFee,
    },
    total,
  };
}

/* ======================================================
   MAIN ROUTER
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

    /* ================= COURIER QUOTE ================= */
    if (pathname === "/api/quote" && method === "POST") {
      const body = await readJson(req);

      const { breakdown, total } = buildCourierQuote({
        miles: body.distance_miles,
      });

      return json(res, 200, {
        quote_id: crypto.randomUUID(),
        breakdown,
        total,
      });
    }

    /* ================= NOTARY QUOTE ================= */
    if (pathname === "/api/notary/quote" && method === "POST") {
      const body = await readJson(req);

      const { breakdown, total } = buildNotaryQuote({
        signers: body.signers,
        document_type: body.document_type,
      });

      return json(res, 200, {
        quote_id: crypto.randomUUID(),
        breakdown,
        total,
      });
    }

    /* ================= UNIFIED ORDER SUBMISSION ================= */
    if (pathname === "/api/orders" && method === "POST") {
      const body = await readJson(req);

      if (!body.service_type || !body.customer_email) {
        return json(res, 400, {
          error: "service_type and customer_email are required",
        });
      }

      const { rows } = await pool.query(
        `INSERT INTO orders (
          service_type,
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
          $1,$2,$3,$4,$5,$6,$7,$8,$9,
          'pending_admin_review',
          'unpaid'
        )
        RETURNING *`,
        [
          body.service_type,
          body.customer_email,
          body.pickup_address || null,
          body.delivery_address || null,
          body.distance_miles || null,
          body.total_amount || 0,
          body.scheduled_date || null,
          body.scheduled_time || null,
          body.notes || null,
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

    /* ================= PUBLIC ================= */
    if (await handleAvailability(req, res, pool, pathname, method, json)) return;
    if (await handleOrders(req, res, pool, pathname, method, json)) return;

    if (pathname === "/" && method === "GET") {
      return text(res, 200, "Smiles In Route API");
    }

    return json(res, 404, { error: "Not found" });

  } catch (err) {
    console.error("[API ROUTER ERROR]", err);
    return json(res, 500, {
      error: err.message || "Server error",
    });
  }
}

module.exports = { handleAPI };