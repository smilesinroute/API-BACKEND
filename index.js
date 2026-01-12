/**
 * Smiles in Route — Main API Router
 * =====================================================
 * Runtime
 * -----------------------------------------------------
 * - Plain Node.js (NO Express)
 * - Single shared Postgres pool (Supabase)
 * - Explicit routing via pathname + method
 *
 * Responsibilities
 * -----------------------------------------------------
 * - Handle all non-webhook API routes
 * - Route driver endpoints FIRST
 * - Provide customer, quote, order, payment APIs
 */

"use strict";

/* =====================================================
   CORE DEPENDENCIES
===================================================== */
const url = require("url");
const crypto = require("crypto");

/* =====================================================
   DRIVER ROUTES (PRIORITY)
===================================================== */
const { handleDriverRoutes } = require("./src/drivers/driverRoutes");
const { handleDriverOrders } = require("./src/drivers/driverOrders");
const { handleDriverAssignments } = require("./src/drivers/driverAssignments");
const { handleDriverProof } = require("./src/drivers/driverProof");

/* =====================================================
   RESPONSE HELPERS
===================================================== */
function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(text);
}

/* =====================================================
   VALIDATION & SANITIZATION
===================================================== */
function asTrimmedString(value) {
  return String(value ?? "").trim();
}

function asNullableTrimmedString(value) {
  const v = asTrimmedString(value);
  return v || null;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(asTrimmedString(email));
}

function assertFiniteNumber(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`${label} must be a number`);
  }
  return n;
}

/* =====================================================
   STRIPE REDIRECT HELPERS
===================================================== */
function getAppOrigin() {
  return asTrimmedString(process.env.APP_ORIGIN) || "http://127.0.0.1:5175";
}

function buildRedirectUrls(orderId) {
  const origin = getAppOrigin();
  const oid = encodeURIComponent(String(orderId));

  const successTpl = asTrimmedString(process.env.STRIPE_SUCCESS_URL);
  const cancelTpl = asTrimmedString(process.env.STRIPE_CANCEL_URL);

  return {
    success_url: successTpl
      ? successTpl.replace("{{ORDER_ID}}", oid)
      : `${origin}/payment-success?order_id=${oid}`,
    cancel_url: cancelTpl
      ? cancelTpl.replace("{{ORDER_ID}}", oid)
      : `${origin}/payment-cancel?order_id=${oid}`,
  };
}

/* =====================================================
   BODY PARSERS (RAW NODE)
===================================================== */
function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
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
  if (!type.includes("application/json")) {
    throw new Error("Content-Type must be application/json");
  }

  const body = await readBody(req);
  if (!body) return {};

  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

/* =====================================================
   DATABASE HELPERS
===================================================== */
async function insertOrderSafe(pool, data) {
  const {
    pickup_address,
    delivery_address,
    service_type,
    total_amount,
    status,
    customer_email,
    distance_miles,
    scheduled_date,
    scheduled_time,
  } = data;

  try {
    const { rows } = await pool.query(
      `
      INSERT INTO orders (
        pickup_address,
        delivery_address,
        service_type,
        total_amount,
        status,
        customer_email,
        distance_miles,
        scheduled_date,
        scheduled_time,
        payment_status
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'unpaid')
      RETURNING id, status
      `,
      [
        pickup_address,
        delivery_address,
        service_type,
        total_amount,
        status,
        customer_email,
        distance_miles,
        scheduled_date,
        scheduled_time,
      ]
    );
    return rows[0];
  } catch {
    const { rows } = await pool.query(
      `
      INSERT INTO orders (
        pickup_address,
        delivery_address,
        service_type,
        total_amount,
        status
      )
      VALUES ($1,$2,$3,$4,$5)
      RETURNING id, status
      `,
      [pickup_address, delivery_address, service_type, total_amount, status]
    );
    return rows[0];
  }
}

/* =====================================================
   EMAIL HELPERS (BEST-EFFORT)
===================================================== */
async function sendConfirmEmailSafe(details) {
  try {
    if (!isValidEmail(details.to)) return false;

    const { sendMail } = require("./src/lib/mailer");

    const text =
      `Order confirmed\n\n` +
      `Order ID: ${details.orderId}\n` +
      `Service: ${details.service_type}\n` +
      `Pickup: ${details.pickup_address || "N/A"}\n` +
      `Dropoff: ${details.delivery_address || "N/A"}\n` +
      `Scheduled: ${details.scheduled_date || "TBD"} ${details.scheduled_time || ""}\n\n` +
      `Estimated Total: $${Number(details.total_amount).toFixed(2)}\n\n` +
      `— Smiles in Route Transportation LLC`;

    await sendMail({
      to: details.to,
      subject: "Smiles in Route – Order Confirmed",
      text,
    });

    return true;
  } catch (err) {
    console.warn("[EMAIL] confirm failed:", err.message);
    return false;
  }
}

/* =====================================================
   MAIN API HANDLER
===================================================== */
async function handleAPI(req, res, pool) {
  const { pathname } = url.parse(req.url, true);
  const method = req.method;

  /* ---------- CORS ---------- */
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (pathname === "/favicon.ico") {
    res.statusCode = 204;
    return res.end();
  }

  /* =====================================================
     DRIVER ROUTES (MUST RUN FIRST)
  ===================================================== */
  try {
    if (await handleDriverRoutes(req, res, pool, pathname, method)) return;
    if (await handleDriverOrders(req, res, pool, pathname, method)) return;
    if (await handleDriverAssignments(req, res, pool, pathname, method)) return;
    if (await handleDriverProof(req, res, pool, pathname, method)) return;
  } catch (err) {
    console.error("[DRIVER] routing error:", err.message);
    return json(res, 500, { error: "Driver routing error" });
  }

  /* ---------- HEALTH ---------- */
  if (pathname === "/api/health" && method === "GET") {
    try {
      await pool.query("SELECT 1");
      return json(res, 200, { status: "ok" });
    } catch {
      return json(res, 500, { status: "db_error" });
    }
  }

  /* ---------- ROOT ---------- */
  if (pathname === "/" && method === "GET") {
    return sendText(res, 200, "Smiles in Route API");
  }

  return json(res, 404, { error: "Not found" });
}

module.exports = { handleAPI };
