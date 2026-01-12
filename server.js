/**
 * Smiles in Route — API Server
 * =====================================================
 * Runtime
 * -----------------------------------------------------
 * - Plain Node.js HTTP server (NO Express)
 * - PostgreSQL connection pool (Supabase-compatible)
 * - Stripe webhook support with raw body handling
 *
 * Responsibilities
 * -----------------------------------------------------
 * - Serve all API requests via a single HTTP entrypoint
 * - Handle Stripe webhooks safely (raw body required)
 * - Share one Postgres pool across all handlers
 * - Support graceful shutdown (Render / local)
 */

"use strict";

/* =====================================================
   ENVIRONMENT
===================================================== */
require("dotenv").config({ override: true });

/* =====================================================
   CORE DEPENDENCIES
===================================================== */
const http = require("http");
const { Pool } = require("pg");

/* =====================================================
   ROUTE HANDLERS
===================================================== */
const { handleAPI } = require("./index");
const { handleStripeWebhook } = require("./src/webhooks/stripe");

/* =====================================================
   CONFIGURATION
===================================================== */
const PORT = Number(process.env.PORT) || 3000;

/* =====================================================
   POSTGRES / SUPABASE CONNECTION POOL
===================================================== */
const pool = new Pool({
  host: process.env.PG_HOST,
  user: process.env.PG_USER,
  password: String(process.env.PG_PASSWORD || ""),
  database: process.env.PG_DATABASE,
  port: Number(process.env.PG_PORT || 5432),
  ssl: {
    require: true,
    rejectUnauthorized: false, // Required for Supabase + Render
  },
});

/* =====================================================
   HTTP SERVER
===================================================== */
const server = http.createServer(async (req, res) => {
  const { url, method } = req;

  /* --------------------------------------------------
     STRIPE WEBHOOK (RAW BODY REQUIRED)
     --------------------------------------------------
     CRITICAL:
     - Must be handled BEFORE any JSON/body parsing
     - No middleware may read req body first
  -------------------------------------------------- */
  if (url === "/api/webhook/stripe" && method === "POST") {
    return handleStripeWebhook(req, res, pool);
  }

  /* --------------------------------------------------
     ALL OTHER API ROUTES
     -------------------------------------------------- */
  return handleAPI(req, res, pool);
});

/* =====================================================
   SERVER STARTUP
===================================================== */
server.listen(PORT, "0.0.0.0", async () => {
  console.log("🚀 Smiles API started");
  console.log(`📡 Port: ${PORT}`);
  console.log(`📊 Health: http://localhost:${PORT}/api/health`);
  console.log(`🔔 Stripe Webhook: http://localhost:${PORT}/api/webhook/stripe`);

  try {
    await pool.query("SELECT 1");
    console.log("✅ Database connected (Supabase)");
  } catch (err) {
    console.error("❌ Database connection failed:", err.message);
  }
});

/* =====================================================
   GRACEFUL SHUTDOWN
===================================================== */
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function shutdown() {
  console.log("\n🛑 Shutting down Smiles API...");

  try {
    await pool.end();
    console.log("✅ Database pool closed");
  } catch (err) {
    console.error("❌ Error closing DB pool:", err.message);
  }

  process.exit(0);
}
