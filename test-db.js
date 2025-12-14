const pool = require('./src/utils/db');

async function testConnection() {
  try {
    const res = await pool.query('SELECT NOW() AS current_time');
    console.log('Database connected successfully! Time:', res.rows[0].current_time);
    process.exit(0);
  } catch (err) {
    console.error('Database connection failed:', err.message);
    process.exit(1);
  }
}

testConnection();
