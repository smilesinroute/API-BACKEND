require("dotenv").config({ override: true });
const { Pool } = require("pg");

const orderId = process.argv[2];

const pool = new Pool({
  host: process.env.PG_HOST || process.env.PGHOST,
  port: Number(process.env.PG_PORT || process.env.PGPORT || 5432),
  user: process.env.PG_USER || process.env.PGUSER,
  password: String(process.env.PG_PASSWORD || process.env.PGPASSWORD || ""),
  database: process.env.PG_DATABASE || process.env.PGDATABASE,
  ssl:
    String(process.env.PG_SSL || "").toLowerCase() === "true"
      ? { rejectUnauthorized: false }
      : undefined,
});

(async () => {
  try {
    const res = await pool.query(
      "SELECT id, status, stripe_session_id, stripe_checkout_url FROM orders WHERE id = $1",
      [orderId]
    );
    console.log(res.rows[0] || "NOT FOUND");
  } catch (err) {
    console.error("DB ERROR:", err.message);
  } finally {
    await pool.end();
  }
})();
