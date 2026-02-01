"use strict";

/**
 * Smiles in Route — Core API Router (Production)
 * =============================================
 * - Plain Node.js HTTP routing (NO Express)
 * - Shared Postgres pool (passed from server.js)
 * - Public + Admin + Driver routes
 * - Stripe webhook runs FIRST (raw body required)
 */

const url = require("url");
const crypto = require("crypto");

/* ======================================================
   EXTERNAL HELPERS
====================================================== */
const { getDistanceMiles } = require("./src/lib/distanceMatrix");

/* ======================================================
   WEBHOOKS (MUST RUN FIRST)
====================================================== */
const { handleStripeWebhook } = require("./src/webhooks/stripeWebhook");

/* ======================================================
   DRIVER ROUTES
====================================================== */
const { handleDriverRoutes } = require("./src/drivers/driverRoutes");
const { handleDriverOrders } = require("./src/drivers/driverOrders");
const { handleDriverAssignments } = require("./src/drivers/driverAssignments");
const { handleDriverProof } = require("./src/drivers/driverProof");

/* ======================================================
   ADMIN ROUTES
====================================================== */
const { handleAdminRoutes } = require("./src/admin/adminRoutes");

/* ======================================================
   RESPONSE HELPERS
====================================================== */
function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function text(res, status, message) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(message);
}

/* ======================================================
   BODY PARSING (RAW NODE)
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
  if (!type.includes("application/json")) {
    throw new Error("Content-Type must be application/json");
  }
  const raw = await readBody(req);
  return raw ? JSON.parse(raw) : {};
}

/* ======================================================
   VALIDATION HELPERS
====================================================== */
const str = (v) => String(v ?? "").trim();

function num(v, label) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${label} must be a number`);
  return n;
}

function isoDate(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v || ""))) {
    throw new Error("scheduled_date must be YYYY-MM-DD");
  }
  return v;
}

function hhmm(v) {
  if (!/^\d{2}:\d{2}$/.test(String(v || ""))) {
    throw new Error("scheduled_time must be HH:MM");
  }
  return v;
}

/* ======================================================
   SCHEDULING HELPERS
====================================================== */
function generateTimeSlots() {
  const slots = [];
  for (let h = 8; h < 18; h++) {
    for (let m = 0; m < 60; m += 30) {
      slots.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
  }
  return slots;
}

/* ======================================================
   CORS (SAFE DEFAULTS)
====================================================== */
function applyCors(req, res) {
  const origin = req.headers.origin;

  // Allow-list for production + local dev
  const allowedOrigins = [
    process.env.ADMIN_ORIGIN,
    process.env.CUSTOMER_ORIGIN,

    "http://localhost:5173", // customer dev
    "http://localhost:5174", // admin dev

    "https://smilesinroute.delivery",
    "https://www.smilesinroute.delivery",

    "https://admin.smilesinroute.delivery",
  ].filter(Boolean);

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else {
    // Public API endpoints (distance/quote) can be ok on *
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Stripe-Signature");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

/* ======================================================
   CORE: ORDER INSERT (USED BY /api/confirm AND /api/orders)
====================================================== */
async function createCourierOrder(pool, body) {
  const pickup = str(body.pickup_address);
  const delivery = str(body.delivery_address);
  const email = str(body.customer_email);

  if (!pickup || !delivery) {
    throw new Error("pickup_address and delivery_address required");
  }

  // Scheduled fields required for “real” orders
  // (Your flow schedules on the schedule step)
  const scheduledDate = isoDate(body.scheduled_date);
  const scheduledTime = hhmm(body.scheduled_time);

  const totalAmount = num(body.total_amount, "total_amount");

  // Keep status aligned with admin “Requires Approval” lane
  const status = "confirmed_pending_payment";

  const { rows } = await pool.query(
    `
    INSERT INTO orders (
      pickup_address,
      delivery_address,
      service_type,
      total_amount,
      scheduled_date,
      scheduled_time,
      customer_email,
      status
    )
    VALUES ($1,$2,'courier',$3,$4,$5,$6,$7)
    RETURNING id, status
    `,
    [pickup, delivery, totalAmount, scheduledDate, scheduledTime, email || null, status]
  );

  return rows[0];
}

/* ======================================================
   MAIN API ROUTER
====================================================== */
async function handleAPI(req, res, pool) {
  const { pathname } = url.parse(req.url, true);
  const method = req.method;

  applyCors(req, res);

  if (method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  /* ======================================================
     STRIPE WEBHOOK (FIRST - RAW BODY)
     POST /api/webhook/stripe
  ====================================================== */
  try {
    const handled = await handleStripeWebhook(req, res, pool);
    if (handled) return;
  } catch (err) {
    console.error("[STRIPE WEBHOOK]", err);
    return json(res, 500, { error: "Webhook error" });
  }

  /* ======================================================
     DRIVER ROUTES
  ====================================================== */
  try {
    if (await handleDriverRoutes(req, res, pool, pathname, method)) return;
    if (await handleDriverOrders(req, res, pool, pathname, method)) return;
    if (await handleDriverAssignments(req, res, pool, pathname, method)) return;
    if (await handleDriverProof(req, res, pool, pathname, method)) return;
  } catch (err) {
    console.error("[DRIVER ROUTING]", err);
    return json(res, 500, { error: "Driver routing error" });
  }

  /* ======================================================
     ADMIN ROUTES
  ====================================================== */
  try {
    if (await handleAdminRoutes(req, res, pool, pathname, method, json)) return;
  } catch (err) {
    console.error("[ADMIN ROUTING]", err);
    return json(res, err.statusCode || 500, { error: err.message || "Admin error" });
  }

  /* ======================================================
     HEALTH CHECK
     GET /api/health
  ====================================================== */
  if (pathname === "/api/health" && method === "GET") {
    try {
      await pool.query("SELECT 1");
      return json(res, 200, { status: "ok" });
    } catch {
      return json(res, 500, { status: "db_error" });
    }
  }

  /* ======================================================
     AVAILABLE TIME SLOTS
     GET /api/available-slots/:date
  ====================================================== */
  if (pathname.startsWith("/api/available-slots/") && method === "GET") {
    try {
      const date = isoDate(pathname.split("/").pop());
      return json(res, 200, { date, availableSlots: generateTimeSlots() });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  /* ======================================================
     DISTANCE
     POST /api/distance
  ====================================================== */
  if (pathname === "/api/distance" && method === "POST") {
    try {
      const body = await readJson(req);
      if (!body.pickup || !body.delivery) {
        return json(res, 400, { error: "pickup and delivery addresses required" });
      }
      const miles = await getDistanceMiles(body.pickup, body.delivery);
      return json(res, 200, { distance_miles: miles });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  /* ======================================================
     QUOTE
     POST /api/quote
  ====================================================== */
  if (pathname === "/api/quote" && method === "POST") {
    try {
      const body = await readJson(req);
      const miles = num(body.distance_miles, "distance_miles");

      const breakdown = {
        base: 25,
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
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  /* ======================================================
     CREATE ORDER (CUSTOMER)
     POST /api/orders   ✅ (your customer UI is calling this)
     POST /api/confirm  ✅ (keep old route too)
  ====================================================== */
  if ((pathname === "/api/orders" || pathname === "/api/confirm") && method === "POST") {
    try {
      const body = await readJson(req);

      const created = await createCourierOrder(pool, body);

      // IMPORTANT: return BOTH keys to avoid frontend mismatch
      return json(res, 201, {
        orderId: created.id,     // ✅ some frontends expect this
        order_id: created.id,    // ✅ your older code expects this
        status: created.status,
      });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  /* ======================================================
     ROOT
  ====================================================== */
  if (pathname === "/" && method === "GET") {
    return text(res, 200, "Smiles in Route API");
  }

  return json(res, 404, { error: "Not found" });
}

module.exports = { handleAPI };
