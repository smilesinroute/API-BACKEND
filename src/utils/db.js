// src/utils/db.js
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  database: process.env.PG_DATABASE,
  password: process.env.PG_PASSWORD,
  port: process.env.PG_PORT ? parseInt(process.env.PG_PORT, 10) : undefined,
  ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 20
});

pool.on('error', (err) => {
  console.error('Unexpected PG error', err);
});

module.exports = pool;
