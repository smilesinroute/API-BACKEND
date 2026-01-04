/**
 * Smiles in Route – API Server
 * -------------------------------------------------
 * - Plain Node HTTP (NO Express)
 * - PostgreSQL via Supabase
 * - Stripe webhook with RAW body support
 */

"use strict";

require("dotenv").config({ override: true });

const http = require("http");
const { Pool } = require("pg");

const { handleAPI } = require("./index");
const { handleStripeWebhook } = require("./src/webhooks/stripe"); // ✅ correct path

const PORT = Number(process.env.PORT) || 3000;

/* ======================================================
   POSTGRES / SUPABASE CONNECTION POOL
====================================================== */
const pool = new Pool({
  host: process.env.PG_HOST,
  user: process.env.PG_USER,
  password: String(process.env.PG_PASSWORD || ""),
  database: process.env.PG_DATABASE,
  port: Number(process.env.PG_PORT || 5432),
  ssl: {
    require: true,
    rejectUnauthorized: false,
  },
});

/* ======================================================
   HTTP SERVER
====================================================== */
const server = http.createServer(async (req, res) => {
  const { url, method } = req;

  /**
   * STRIPE WEBHOOK (RAW BODY REQUIRED)
   * ----------------------------------
   * Must be handled BEFORE any JSON parsing.
   */
  if (url === "/api/webhook/stripe" && method === "POST") {
    return handleStripeWebhook(req, res, pool);
  }

  /**
   * ALL OTHER API ROUTES
   */
  return handleAPI(req, res, pool);
});

/* ======================================================
   START SERVER
====================================================== */
server.listen(PORT, "0.0.0.0", async () => {
  console.log(`🚀 Smiles API running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
  console.log(`🔔 Stripe webhook: http://localhost:${PORT}/api/webhook/stripe`);

  try {
    await pool.query("SELECT 1");
    console.log("✅ Database connected (Supabase)");
  } catch (err) {
    console.error("❌ Database connection failed:", err.message);
  }
});

/* ======================================================
   GRACEFUL SHUTDOWN
====================================================== */
process.on("SIGINT", async () => {
  console.log("\n🛑 Shutting down server...");
  try {
    await pool.end();
    console.log("✅ Database pool closed");
  } catch (e) {
    console.error("❌ Error closing DB pool:", e.message);
  }
  process.exit(0);
});
