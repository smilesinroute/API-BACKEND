"use strict";

/**
 * Smiles in Route — Core API Router (Production)
 * ==============================================
 * - Plain Node.js HTTP routing (NO Express)
 * - Shared Postgres pool
 * - Safe CORS handling
 * - Hardened routing with isolation
 * - Stripe webhook safe handling
 */

const url = require("url");
const crypto = require("crypto");

/* ======================================================
   EXTERNAL HELPERS
====================================================== */
const { getDistanceMiles } = require("./src/lib/distanceMatrix");

/* ======================================================
   WEBHOOKS
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
   PLATFORM ROUTES
====================================================== */
const { handleAvailability } = require("./src/controllers/availabilityController");

/* ======================================================
   ORDERS
====================================================== */
const { handleOrders } = require("./src/controllers/ordersController");

/* ======================================================
   RESPONSE HELPERS
====================================================== */
function json(res, status, payload) {
  try {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(payload));
  } catch (err) {
    console.error("[JSON RESPONSE ERROR]", err);
    try {
      res.statusCode = 500;
      res.end('{"error":"response_failure"}');
    } catch {}
  }
}

function text(res, status, message) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(message);
}

/* ======================================================
   CORS (MUST RUN FIRST)
====================================================== */
function applyCors(req, res) {
  const origin = req.headers.origin || "*";

  const allowedOrigins = [
    process.env.CUSTOMER_ORIGIN,
    process.env.ADMIN_ORIGIN,
    process.env.DRIVER_ORIGIN,
    process.env.OPS_ORIGIN,

    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:5176",
    "http://localhost:5177",

    "https://smilesinroute.delivery",
    "https://www.smilesinroute.delivery",
    "https://admin.smilesinroute.delivery",
    "https://driver.smilesinroute.delivery",
    "https://ops.smilesinroute.delivery",
  ].filter(Boolean);

  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Stripe-Signature"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
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
function num(v, label) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${label} must be a number`);
  return n;
}

/* ======================================================
   SAFE ROUTE WRAPPER
====================================================== */
async function safeRoute(label, fn, res) {
  try {
    return await fn();
  } catch (err) {
    console.error(`[${label}]`, err);
    json(res, 500, { error: `${label.toLowerCase()} error` });
    return true;
  }
}

/* ======================================================
   MAIN API ROUTER
====================================================== */
async function handleAPI(req, res, pool) {
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  const method = req.method || "GET";
  const rawUrl = String(req.url || "/");
  const { pathname } = url.parse(rawUrl, true);

  /* ======================================================
     STRIPE WEBHOOK
  ====================================================== */
  if (rawUrl.startsWith("/api/webhook/stripe")) {
    return safeRoute("STRIPE WEBHOOK", async () => {
      const handled = await handleStripeWebhook(req, res, pool);
      if (!handled) json(res, 404, { error: "Webhook not handled" });
      return true;
    }, res);
  }

  /* ======================================================
     DRIVER ROUTES
  ====================================================== */
  if (
    await safeRoute("DRIVER ROUTING", async () => {
      if (await handleDriverRoutes(req, res, pool, pathname, method)) return true;
      if (await handleDriverOrders(req, res, pool, pathname, method)) return true;
      if (await handleDriverAssignments(req, res, pool, pathname, method)) return true;
      if (await handleDriverProof(req, res, pool, pathname, method)) return true;
      return false;
    }, res)
  ) return;

  /* ======================================================
     PLATFORM ROUTES
  ====================================================== */
  if (
    await safeRoute("AVAILABILITY ROUTING", async () => {
      return await handleAvailability(req, res, pool, pathname, method, json);
    }, res)
  ) return;

  /* ======================================================
     ORDERS
  ====================================================== */
  if (
    await safeRoute("ORDERS ROUTING", async () => {
      return await handleOrders(req, res, pool, pathname, method, json);
    }, res)
  ) return;

  /* ======================================================
     ADMIN ROUTES
  ====================================================== */
  if (
    await safeRoute("ADMIN ROUTING", async () => {
      return await handleAdminRoutes(req, res, pool, pathname, method, json);
    }, res)
  ) return;

  /* ======================================================
     HEALTH
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
     DISTANCE
  ====================================================== */
  if (pathname === "/api/distance" && method === "POST") {
    try {
      const body = await readJson(req);
      if (!body.pickup || !body.delivery) {
        return json(res, 400, { error: "pickup and delivery required" });
      }

      const miles = await getDistanceMiles(body.pickup, body.delivery);
      return json(res, 200, { distance_miles: miles });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  /* ======================================================
     QUOTE
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
     ROOT
  ====================================================== */
  if (pathname === "/" && method === "GET") {
    return text(res, 200, "Smiles in Route API");
  }

  return json(res, 404, { error: "Not found" });
}

module.exports = { handleAPI };
