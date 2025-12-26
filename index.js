const url = require('url');

/*
========================================
 API REQUEST HANDLER
 - Stateless
 - Uses Supabase Postgres via pg pool
 - Schema-aligned (NO guessing)
========================================
*/
async function handleAPI(req, res, pool) {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  /* -----------------------------------
     CORS
  ----------------------------------- */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, DELETE, OPTIONS'
  );
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type'
  );

  if (method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  /* -----------------------------------
     HEALTH CHECK
     GET /api/health
  ----------------------------------- */
  if (pathname === '/api/health' && method === 'GET') {
    try {
      await pool.query('SELECT 1');

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

  /* -----------------------------------
     DRIVER — GET ORDERS
     GET /api/driver/orders
  ----------------------------------- */
  if (pathname === '/api/driver/orders' && method === 'GET') {
    try {
      const { rows } = await pool.query(`
        SELECT
          id,
          pickup_address,
          delivery_address,
          status,
          service_type,
          total_amount,
          created_at
        FROM orders
        ORDER BY created_at DESC
        LIMIT 25
      `);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rows));
    } catch (err) {
      console.error('[API] driver/orders error:', err.message);

      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Failed to fetch driver orders',
      }));
    }
    return;
  }

  /* -----------------------------------
     FALLBACK
  ----------------------------------- */
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    error: 'Endpoint not found',
  }));
}

module.exports = {
  handleAPI,
};
