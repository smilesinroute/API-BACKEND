"use strict";

/**
 * Smiles In Route — Core API Router
 * =================================
 * Plain Node.js router (NO Express)
 * This file is the SINGLE source of truth for routing.
 */

const url = require("url");
const crypto = require("crypto");

/* ================================
   HELPERS
================================ */
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

/* ================================
   CORS (FIXES CONFIRM FAILURE)
================================ */
function applyCors(req, res) {
  const origin = req.headers.origin;

  const allowed = [
    "https://smilesinroute.delivery",
    "https://www.smilesinroute.delivery",
    "https://admin.smilesinroute.delivery",
    "https://driver.smilesinroute.delivery",
    "http://localhost:5173",
  ];

  if (origin && allowed.includes(origin)) {
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

/* ================================
   BODY PARSING
================================ */
function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Body too large"));
        req.destroy();
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
  const raw = await readBody(req);
  return raw ? JSON.parse(raw) : {};
}

/* ================================
   CONTROLLERS (REAL PATHS)
================================ */
const { handleOrders } = require("./src/controllers/ordersController");
const { handleAvailability } = require("./src/controllers/availabilityController");
const { handleAdminRoutes } = require("./src/admin/adminRoutes");
const { handleDriverRoutes } = require("./src/drivers/driverRoutes");

/* ================================
   MAIN ROUTER
================================ */
async function handleAPI(req, res, pool) {
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  const method = req.method;
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  /* ============================
     HEALTH
  ============================ */
  if (pathname === "/api/health" && method === "GET") {
    try {
      await pool.query("SELECT 1");
      return json(res, 200, { status: "ok" });
    } catch {
      return json(res, 500, { status: "db_error" });
    }
  }

  /* ============================
     AVAILABILITY (READ ONLY)
     GET /api/available-slots/:date
  ============================ */
  if (await handleAvailability(req, res, pool, pathname, method, json)) {
    return;
  }

  /* ============================
     ORDERS (CREATE / CONFIRM)
  ============================ */
  if (await handleOrders(req, res, pool, pathname, method, json)) {
    return;
  }

  /* ============================
     DRIVER
  ============================ */
  if (await handleDriverRoutes(req, res, pool, pathname, method)) {
    return;
  }

  /* ============================
     ADMIN
  ============================ */
  if (await handleAdminRoutes(req, res, pool, pathname, method, json)) {
    return;
  }

  /* ============================
     ROOT
  ============================ */
  if (pathname === "/" && method === "GET") {
    return text(res, 200, "Smiles In Route API");
  }

  return json(res, 404, { error: "Not found" });
}

module.exports = { handleAPI };

