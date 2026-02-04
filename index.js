"use strict";

/**
 * Smiles in Route — Core API Router (Production)
 * =============================================
 * - Plain Node.js HTTP routing (NO Express)
 * - Shared Postgres pool
 * - Proper CORS + preflight handling
 * - Stripe webhook handled safely
 * - Platform + Admin + Driver endpoints
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
const {
  handleAvailability,
} = require("./src/controllers/availabilityController");

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
   CORS (MUST RUN FIRST)
====================================================== */
function applyCors(req, res) {
  const origin = req.headers.origin;

  const allowedOrigins = [
    // environment-defined
    process.env.CUSTOMER_ORIGIN,
    process.env.ADMIN_ORIGIN,
    process.env.DRIVER_ORIGIN,
    process.env.OPS_ORIGIN,

    // local development
    "http://localhost:5173", // customer
    "http://localhost:5174", // admin
    "http://localhost:5176", // driver
    "http://localhost:5177", // ops

    // production
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
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Stripe-Signature"
  );
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,OPTIONS"
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
   MAIN API ROUTER
====================================================== */
async function handleAPI(req, res, pool) {
  /* ===== CORS + PREFLIGHT ===== */
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
    try {
      const handled = await handleStripeWebhook(req, res, pool);
      if (handled) return;
    } catch (err) {
      console.error("[STRIPE WEBHOOK]", err);
      return json(res, 500, { error: "Webhook error" });
    }
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
     PLATFORM ROUTES
  ====================================================== */
  try {
    if (
      await handleAvailability(
        req,
        res,
        pool,
        pathname,
        method,
        json
      )
    ) {
      return;
    }
  } catch (err) {
    console.error("[AVAILABILITY ROUTING]", err);
    return json(res, 500, { error: "Availability error" });
  }

  /* ======================================================
     ADMIN ROUTES
  ====================================================== */
  try {
    if (
      await handleAdminRoutes(
        req,
        res,
        pool,
        pathname,
        method,
        json
      )
    ) {
      return;
    }
  } catch (err) {
    console.error("[ADMIN ROUTING]", err);
    return json(res, err.statusCode || 500, {
      error: err.message || "Admin error",
    });
  }

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
        return json(res, 400, {
          error: "pickup and delivery required",
        });
      }

      const miles = await getDistanceMiles(
        body.pickup,
        body.delivery
      );
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

      const total = Object.values(breakdown).reduce(
        (a, b) => a + b,
        0
      );

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
