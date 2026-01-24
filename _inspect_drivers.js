require('dotenv').config();
const { Pool } = require('pg');

(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL
  });

  const res = await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'drivers' ORDER BY ordinal_position"
  );

  console.log(res.rows.map(r => r.column_name));
  await pool.end();
})();
