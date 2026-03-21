
"use strict";

const { URL } = require("url");

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

const { handleCompanySignup } = require("./src/controllers/companySignup");

/* ===============================
   SAAS (NEW)
=============================== */

const saasOrders = require("./src/saas/orders");
const saasDrivers = require("./src/saas/drivers");

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

    /* ===============================
       DRIVER APP (mobile drivers)
    =============================== */
    if (await handleDriverLogin(req, res, pool)) return;
    if (await handleDriverRoutes(req, res, pool, pathname, method)) return;
    if (await handleDriverOrders(req, res, pool, pathname, method)) return;
    if (await handleDriverAssignments(req, res, pool, pathname, method)) return;
    if (await handleDriverProof(req, res, pool, pathname, method)) return;

    /* ===============================
       COMPANY SIGNUP
    =============================== */
    if (await handleCompanySignup(req, res, pool, pathname, method, json)) return;

    /* ===============================
       ADMIN (internal tools)
    =============================== */
    if (await handleAdminRoutes(req, res, pool, pathname, method, json)) return;

    /* ===============================
       🚀 SAAS API (NEW SYSTEM)
    =============================== */

    // ✅ drivers FIRST
    if (await saasDrivers(req, res, pathname)) return;

    // ✅ then orders
    if (await saasOrders(req, res, pathname)) return;

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