"use strict";

/**
 * Smiles in Route — API Server
 * =====================================================
 * - Plain Node.js HTTP server (NO Express)
 * - Shared Postgres pool (Supabase)
 * - Stripe webhook with raw body
 */

require("dotenv").config({ override: true });

const http = require("http");
const { Pool } = require("pg");

const { handleAPI } = require("./index");
const { handleStripeWebhook } = require("./src/webhooks/stripe");

const PORT = Number(process.env.PORT) || 3000;

/* =========================
   DATABASE POOL
========================= */
const pool = new Pool({
  host: process.env.PG_HOST,
  user: process.env.PG_USER,
  password: String(process.env.PG_PASSWORD || ""),
  database: process.env.PG_DATABASE,
  port: Number(process.env.PG_PORT || 5432),
  ssl: { require: true, rejectUnauthorized: false },
});

/* =========================
   AUTO-CLEAN SCHEDULING HOLDS
========================= */
setInterval(async () => {
  try {
    await pool.query(`
      DELETE FROM deliveries
      WHERE status = 'scheduled'
        AND hold_expires_at IS NOT NULL
        AND hold_expires_at < NOW()
    `);

    await pool.query(`
      DELETE FROM notary_appointments
      WHERE status = 'scheduled'
        AND hold_expires_at IS NOT NULL
        AND hold_expires_at < NOW()
    `);
  } catch (err) {
    console.error("❌ Hold cleanup failed:", err.message);
  }
}, 5 * 60 * 1000);

/* =========================
   HTTP SERVER
========================= */
const server = http.createServer((req, res) => {
  if (req.url === "/api/webhook/stripe" && req.method === "POST") {
    return handleStripeWebhook(req, res, pool);
  }

  return handleAPI(req, res, pool);
});

server.listen(PORT, "0.0.0.0", async () => {
  console.log(`🚀 Smiles API running on port ${PORT}`);
  console.log(`📊 Health: /api/health`);

  try {
    await pool.query("SELECT 1");
    console.log("✅ Database connected");
  } catch (err) {
    console.error("❌ Database error:", err.message);
  }
});

/* =========================
   GRACEFUL SHUTDOWN
========================= */
async function shutdown() {
  try {
    await pool.end();
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
