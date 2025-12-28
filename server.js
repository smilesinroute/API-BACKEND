require('dotenv').config();
const http = require('http');
const { Pool } = require('pg');
const { handleAPI } = require('./index');
const { handleStripeWebhook } = require('./src/webhook/stripeWebhook');

const PORT = process.env.PORT || 3000;

/* ---------------------------
   SUPABASE POSTGRES POOL
--------------------------- */
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

/* ---------------------------
   SERVER
--------------------------- */
const server = http.createServer((req, res) => {
  const { url, method } = req;

  /**
   * IMPORTANT:
   * Stripe requires the RAW body.
   * This route must run BEFORE any body parsing.
   */
  if (url === '/api/webhook/stripe' && method === 'POST') {
    handleStripeWebhook(req, res, pool);
    return;
  }

  /**
   * All other API routes
   */
  handleAPI(req, res, pool);
});

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`🚀 Smiles API running on port ${PORT}`);
  console.log(`📊 Health check: /api/health`);
  console.log(`🔔 Stripe webhook: /api/webhook/stripe`);

  try {
    await pool.query('SELECT 1');
    console.log('✅ Database connected (Supabase)');
  } catch (err) {
    console.error('❌ Database connection failed:', err.message);
  }
});
