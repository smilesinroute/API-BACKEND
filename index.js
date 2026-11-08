
"use strict";

const { URL } = require("url");

/* ===============================
   CONTROLLERS
=============================== */

const { handleOrders } = require("./src/controllers/ordersController");
const { handleQuote } = require("./src/routes/quote");
const { handleNotary } = require("./src/controllers/notaryController");
const { handleAvailability } = require("./src/controllers/availabilityController");
const { handleAdminRoutes } = require("./src/admin/adminRoutes");

const { handleDriverLogin } = require("./src/drivers/driverLogin");
const { handleDriverRoutes } = require("./src/drivers/driverRoutes");
const { handleDriverOrders } = require("./src/drivers/driverOrders");
const { handleDriverLocation } = require("./src/drivers/driverLocation");
const { handleDriverAssignments } = require("./src/drivers/driverAssignments");
const { handleDriverProof } = require("./src/drivers/driverProof");

const { handleCompanySignup } = require("./src/controllers/companySignup");

/* ❌ REMOVE SAAS */
// const saasCompany = require("./src/saas/companyLookup");
// const saasOrders = require("./src/saas/orders");
// const saasDrivers = require("./src/saas/drivers");

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
      "http://localhost:8080",
      "http://127.0.0.1",
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

  // ✅ Normalize /api
  if (pathname.startsWith("/api/")) {
    pathname = pathname.slice(4);
  }

  try {

    /* ===============================
       HEALTH
    =============================== */
    if (pathname === "/health" && method === "GET") {
      await pool.query("SELECT 1");
      return json(res, 200, { status: "ok" });
    }

    // The quote handler expects the full public path, including /api.
    if (parsed.pathname === "/api/quote" && method === "POST") {
      return await handleQuote(req, res, pool, parsed.pathname, method, json);
    }

    // Pass full paths only to these public operations. Order reads/status/payment
    // mutations remain private and are not exposed by this routing repair.
    if (parsed.pathname === "/api/schedule" && method === "GET") {
      return await handleAvailability(req, res, pool, parsed.pathname, method, json);
    }
    if (parsed.pathname === "/api/orders" && method === "POST") {
      return await handleOrders(req, res, pool, parsed.pathname, method, json);
    }
    if ((parsed.pathname === "/api/notary/schedule" && method === "GET") ||
        (parsed.pathname === "/api/notary/requests" && method === "POST")) {
      return await handleNotary(req, res, pool, parsed.pathname, method, json);
    }

    /* ===============================
       DRIVER APP
    =============================== */
    if (await handleDriverLogin(req, res, pool)) return;
    if (await handleDriverRoutes(req, res, pool, pathname, method)) return;
    if (parsed.pathname === "/api/driver/orders" && method === "GET") {
      return await handleDriverOrders(req, res, pool, parsed.pathname, method);
    }
    if (parsed.pathname === "/api/driver/location" && method === "POST") {
      return await handleDriverLocation(req, res, pool);
    }
    if (await handleDriverOrders(req, res, pool, pathname, method)) return;
    if (await handleDriverAssignments(req, res, pool, pathname, method)) return;
    if (await handleDriverProof(req, res, pool, pathname, method)) return;

    /* ===============================
       COMPANY SIGNUP
    =============================== */
    if (await handleCompanySignup(req, res, pool, pathname, method, json)) return;

    /* ===============================
       ADMIN
    =============================== */
    if (await handleAdminRoutes(req, res, pool, pathname, method, json)) return;

    /* ===============================
       PUBLIC COMPANY WEBSITE
    =============================== */
    if (await handleOrders(req, res, pool, pathname, method, json)) return;
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
    return json(res, 500, { error: "Server error" });
  }
}

module.exports = { handleAPI };

