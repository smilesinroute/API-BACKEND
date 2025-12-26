require('dotenv').config();
const http = require('http');
const { Pool } = require('pg');
const { handleAPI } = require('./index');

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
const server = http.createServer((req, res) =>
  handleAPI(req, res, pool)
);

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`🚀 Smiles API running on port ${PORT}`);
  console.log(`📊 Health check: /api/health`);

  try {
    await pool.query('select 1');
    console.log('✅ Database connected (Supabase)');
  } catch (err) {
    console.error('❌ Database connection failed:', err.message);
  }
});
