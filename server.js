/**
 * Smiles in Route â€“ API Server
 * ---------------------------------------
 * - Plain Node HTTP (no Express)
 * - PostgreSQL via Supabase
 * - Stripe webhook with RAW body support
 */

require('dotenv').config({ override: true });
const http = require('http');
const { Pool } = require('pg');

const { handleAPI } = require('./index');
const { handleStripeWebhook } = require('./src/webhook/stripeWebhook');

const PORT = process.env.PORT || 3000;

/* ======================================================
   SUPABASE POSTGRES CONNECTION POOL
====================================================== */
const pool = new Pool({
  host: process.env.PG_HOST,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE,
  port: Number(process.env.PG_PORT),
  ssl: {
    require: true,
    rejectUnauthorized: false,
  },
});

/* ======================================================
   HTTP SERVER
====================================================== */
const server = http.createServer((req, res) => {
  const { url, method } = req;

  /**
   * STRIPE WEBHOOK
   * -----------------------------------
   * MUST receive the raw request body.
   * MUST be handled before any other logic.
   */
  if (url === '/api/webhook/stripe' && method === 'POST') {
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
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`ðŸš€ Smiles API running on port ${PORT}`);
  console.log(`ðŸ“Š Health check: /api/health`);
  console.log(`ðŸ”” Stripe webhook: /api/webhook/stripe`);

  try {
    await pool.query('SELECT 1');
    console.log('âœ… Database connected (Supabase)');
  } catch (err) {
    console.error('âŒ Database connection failed:', err.message);
  }
});

