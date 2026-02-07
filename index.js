"use strict";

/**
 * Smiles In Route — Core API Router (Production)
 * ==============================================
 * - Plain Node.js routing (NO Express)
 * - CORS handled FIRST (including OPTIONS)
 * - Restores required endpoints used by Customer UI:
 *    - POST /api/distance
 *    - POST /api/quote
 *    - POST /api/confirm        (alias create order)
 *    - GET  /api/schedule       (available time slots)
 *    - POST /api/schedule       (save schedule to order)
 * - Delegates:
 *    - /api/orders  -> ordersController
 *    - /admin/*     -> adminRoutes
 *    - /driver/*    -> driver routes
 */

const url = require("url");
const crypto = require("crypto");

/* ======================================================
   External helpers
====================================================== */
let getDistanceMiles;
try {
  ({ getDistanceMiles } = require("./src/lib/distanceMatrix"));
} catch (e) {
  // If distanceMatrix path changes, fail gracefully at runtime with a clear error
  getDistanceMiles = null;
}

/* ======================================================
   Controllers
====================================================== */
const { handleOrders } = require("./src/controllers/ordersController");
const { handleAvailability } = require("./src/controllers/availabilityController");
const { handleAdminRoutes } = require("./src/admin/adminRoutes");

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
   CORS (MUST RUN FIRST)
====================================================== */
function applyCors(req, res) {
  const origin = req.headers.origin;

  const allowedOrigins = [
    // env-defined (recommended)
    process.env.CUSTOMER_ORIGIN,
    process.env.ADMIN_ORIGIN,
    process.env.DRIVER_ORIGIN,
    process.env.OPS_ORIGIN,

    // local dev
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:5175",
    "http://localhost:5176",
    "http://localhost:5177",

    // prod
    "https://smilesinroute.delivery",
    "https://www.smilesinroute.delivery",
    "https://admin.smilesinroute.delivery",
    "https://driver.smilesinroute.delivery",
    "https://ops.smilesinroute.delivery",
  ].filter(Boolean);

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else {
    // If you want to lock down later, remove "*" fallback
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  // IMPORTANT: If you ever set Allow-Credentials true, you should not use "*".
  // But your current system uses Bearer tokens and public endpoints; we keep this consistent.
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Stripe-Signature"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
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
    // allow empty (some clients omit content-type)
    // but if provided, must be JSON
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

function mustNumber(v, label) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${label} must be a number`);
  return n;
}

/* ======================================================
   Scheduling helpers
====================================================== */
function buildDefaultSlots() {
  // Keep it simple + deterministic for now (matches your UI)
  return ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00"];
}

function isISODate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isTimeHHMM(s) {
  return typeof s === "string" && /^\d{2}:\d{2}$/.test(s);
}

/* ======================================================
   MAIN ROUTER
====================================================== */
async function handleAPI(req, res, pool) {
  // Always apply CORS first so even errors/preflight get headers.
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  const method = String(req.method || "GET").toUpperCase();
  const rawUrl = String(req.url || "/");
  const parsed = url.parse(rawUrl, true);
  const pathname = parsed.pathname || "/";
  const query = parsed.query || {};

  try {
    /* =========================
       HEALTH
    ========================= */
    if (pathname === "/api/health" && method === "GET") {
      try {
        await pool.query("SELECT 1");
        return json(res, 200, { status: "ok" });
      } catch {
        return json(res, 500, { status: "db_error" });
      }
    }

    /* =========================
       DISTANCE
       POST /api/distance
       Body: { pickup, delivery }
    ========================= */
    if (pathname === "/api/distance" && method === "POST") {
      if (!getDistanceMiles) {
        return json(res, 500, { error: "Distance service not configured" });
      }

      const body = await readJson(req);
      if (!body.pickup || !body.delivery) {
        return json(res, 400, { error: "pickup and delivery required" });
      }

      const miles = await getDistanceMiles(body.pickup, body.delivery);
      return json(res, 200, { distance_miles: miles });
    }

    /* =========================
       QUOTE
       POST /api/quote
       Body: { distance_miles, fragile, priority, timeSensitive, vehicle? }
    ========================= */
    if (pathname === "/api/quote" && method === "POST") {
      const body = await readJson(req);
      const miles = mustNumber(body.distance_miles, "distance_miles");

      // NOTE: vehicle selection is not implemented in your UI yet.
      // This keeps backward compatibility with your existing pricing.
      const base = 25;

      const breakdown = {
        base,
        mileage: Number((miles * 2.25).toFixed(2)),
        fragile: body.fragile ? 10 : 0,
        priority: body.priority ? 15 : 0,
        timeSensitive: body.timeSensitive ? 20 : 0,
      };

      const total = Object.values(breakdown).reduce((a, b) => a + b, 0);

      return json(res, 200, {
        quote_id: crypto.randomUUID(),
        breakdown,
        total,
      });
    }

    /* =========================
       SCHEDULE (available slots)
       GET /api/schedule?date=YYYY-MM-DD&serviceType=delivery
       Response: { availableSlots: [...] }
    ========================= */
    if (pathname === "/api/schedule" && method === "GET") {
      const date = String(query.date || "");
      // serviceType currently unused but accepted
      if (!isISODate(date)) {
        return json(res, 200, { availableSlots: [] });
      }
      return json(res, 200, { availableSlots: buildDefaultSlots() });
    }

    /* =========================
       SCHEDULE (persist selection)
       POST /api/schedule
       Body: { order_id, scheduled_date, scheduled_time }
    ========================= */
    if (pathname === "/api/schedule" && method === "POST") {
      const body = await readJson(req);
      const orderId = String(body.order_id || "").trim();
      const scheduledDate = String(body.scheduled_date || "").trim();
      const scheduledTime = String(body.scheduled_time || "").trim();

      if (!orderId) return json(res, 400, { error: "order_id is required" });
      if (!isISODate(scheduledDate)) return json(res, 400, { error: "scheduled_date must be YYYY-MM-DD" });
      if (!isTimeHHMM(scheduledTime)) return json(res, 400, { error: "scheduled_time must be HH:MM" });

      const { rows } = await pool.query(
        `UPDATE orders
         SET scheduled_date = $2,
             scheduled_time = $3
         WHERE id = $1
         RETURNING *`,
        [orderId, scheduledDate, scheduledTime]
      );

      if (!rows.length) return json(res, 404, { error: "Order not found" });
      return json(res, 200, rows[0]);
    }

    /* =========================
       CONFIRM (alias used by UI)
       POST /api/confirm  -> creates order (same as POST /api/orders)
       This is the endpoint your UI is hitting when Finalize is clicked.
    ========================= */
    if (pathname === "/api/confirm" && method === "POST") {
      const body = await readJson(req);

      if (!body.customer_email) {
        return json(res, 400, { error: "customer_email is required" });
      }

      const { rows } = await pool.query(
        `
        INSERT INTO orders (
          service_type,
          customer_id,
          customer_email,
          pickup_address,
          delivery_address,
          scheduled_date,
          scheduled_time,
          distance_miles,
          total_amount,
          status,
          payment_status
        )
        VALUES (
          'courier',
          $1,$2,$3,$4,$5,$6,$7,$8,
          'confirmed_pending_payment',
          'unpaid'
        )
        RETURNING *
        `,
        [
          body.customer_id || null,
          body.customer_email,
          body.pickup_address || null,
          body.delivery_address || null,
          body.scheduled_date || null,
          body.scheduled_time || null,
          body.distance_miles || 0,
          body.total_amount || 0,
        ]
      );

      return json(res, 201, rows[0]);
    }

    /* =========================
       PLATFORM AVAILABILITY (your existing controller)
    ========================= */
    if (await handleAvailability(req, res, pool, pathname, method, json)) return;

    /* =========================
       ORDERS (existing controller)
    ========================= */
    if (await handleOrders(req, res, pool, pathname, method, json)) return;

    /* =========================
       DRIVER ROUTES
    ========================= */
    if (await handleDriverRoutes(req, res, pool, pathname, method)) return;
    if (await handleDriverOrders(req, res, pool, pathname, method)) return;
    if (await handleDriverAssignments(req, res, pool, pathname, method)) return;
    if (await handleDriverProof(req, res, pool, pathname, method)) return;

    /* =========================
       ADMIN ROUTES
    ========================= */
    if (await handleAdminRoutes(req, res, pool, pathname, method, json)) return;

    /* =========================
       ROOT
    ========================= */
    if (pathname === "/" && method === "GET") {
      return text(res, 200, "Smiles In Route API");
    }

    return json(res, 404, { error: "Not found" });
  } catch (err) {
    console.error("[API ROUTER ERROR]", err);
    // CORS is already applied above, so browser will see this.
    return json(res, 500, { error: err.message || "Server error" });
  }
}

module.exports = { handleAPI };
