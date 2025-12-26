const url = require('url');

/* ---------------------------
   API Handler (NO DB SETUP)
--------------------------- */
async function handleAPI(req, res, pool) {
  const parsedUrl = url.parse(req.url, true);
  const path = parsedUrl.pathname;
  const method = req.method;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  /* ---------------------------
     HEALTH CHECK
  --------------------------- */
  if (path === '/api/health' && method === 'GET') {
    try {
      await pool.query('select 1');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'healthy',
        database: 'connected',
        timestamp: new Date().toISOString(),
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'unhealthy',
        error: err.message,
      }));
    }
    return;
  }

  /* ---------------------------
     DRIVER — GET ORDERS
  --------------------------- */
  if (path === '/api/driver/orders' && method === 'GET') {
    try {
      const result = await pool.query(`
        SELECT
          order_id AS id,
          pickup_address,
          delivery_address,
          status
        FROM orders
        ORDER BY created_at DESC
        LIMIT 25
      `);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.rows));
    } catch (err) {
      console.error('Driver orders error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to fetch driver orders' }));
    }
    return;
  }

  /* ---------------------------
     DEFAULT
  --------------------------- */
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint not found' }));
}

module.exports = { handleAPI };

