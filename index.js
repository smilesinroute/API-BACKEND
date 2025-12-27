const url = require('url');
const crypto = require('crypto');

/*
========================================
 API REQUEST HANDLER
 - Stateless
 - Plain Node HTTP (no Express)
 - Uses pg pool passed from server.js
========================================
*/
async function handleAPI(req, res, pool) {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  /* =========================
     CORS
  ========================= */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  /* =========================
     SHARED PRICING LOGIC
     (single source of truth)
  ========================= */
  function calculatePricing({
    fragile = false,
    priority = false,
    sensitive = false,
    timeSensitive = false,
  }) {
    const DISTANCE_MILES = 10; // placeholder (swap with Maps later)
    const BASE_FEE = 25;
    const RATE_PER_MILE = 2.25;

    const mileageCost = DISTANCE_MILES * RATE_PER_MILE;

    const total =
      BASE_FEE +
      mileageCost +
      (fragile ? 10 : 0) +
      (priority ? 15 : 0) +
      (sensitive ? 12 : 0) +
      (timeSensitive ? 20 : 0);

    return {
      distance_miles: Number(DISTANCE_MILES.toFixed(2)),
      breakdown: {
        base_fee: BASE_FEE,
        mileage_cost: Number(mileageCost.toFixed(2)),
        fragile_fee: fragile ? 10 : 0,
        priority_fee: priority ? 15 : 0,
        sensitive_fee: sensitive ? 12 : 0,
        time_sensitive_fee: timeSensitive ? 20 : 0,
      },
      total: Number(total.toFixed(2)),
    };
  }

  /* =========================
     HEALTH CHECK
     GET /api/health
  ========================= */
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

  /* =========================
     CUSTOMER — PREVIEW QUOTE
     POST /api/quote
     (15 min expiry, no DB write)
  ========================= */
  if (pathname === '/api/quote' && method === 'POST') {
    let body = '';

    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { pickup_address, delivery_address } = payload;

        if (!pickup_address || !delivery_address) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'pickup_address and delivery_address are required',
          }));
          return;
        }

        const pricing = calculatePricing(payload);
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          quote_id: crypto.randomUUID(),
          ...pricing,
          expires_at: expiresAt.toISOString(),
        }));
      } catch (err) {
        console.error('[API] quote error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to generate quote' }));
      }
    });

    return;
  }

  /* =========================
     CUSTOMER — CONFIRM QUOTE
     POST /api/confirm
     (recalculate + create order)
  ========================= */
  if (pathname === '/api/confirm' && method === 'POST') {
    let body = '';

    req.on('data', chunk => (body += chunk));
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const { quote_id, pickup_address, delivery_address } = payload;

        if (!quote_id || !pickup_address || !delivery_address) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'quote_id, pickup_address, and delivery_address are required',
          }));
          return;
        }

        const pricing = calculatePricing(payload);

        const { rows } = await pool.query(
          `
          INSERT INTO orders (
            pickup_address,
            delivery_address,
            status
          )
          VALUES ($1, $2, 'confirmed_pending_payment')
          RETURNING id, status, created_at
          `,
          [pickup_address, delivery_address]
        );

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          order_id: rows[0].id,
          status: rows[0].status,
          total: pricing.total,
        }));
      } catch (err) {
        console.error('[API] confirm error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to confirm quote' }));
      }
    });

    return;
  }
  /* =========================
     CUSTOMER — SCHEDULE ORDER
     POST /api/schedule
  ========================= */
  if (pathname === '/api/schedule' && method === 'POST') {
    let body = '';

    req.on('data', chunk => (body += chunk));
    req.on('end', async () => {
      try {
        const { order_id, scheduled_date, scheduled_time } = JSON.parse(body);

        if (!order_id || !scheduled_date || !scheduled_time) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'order_id, scheduled_date, and scheduled_time are required',
          }));
          return;
        }

        // Ensure order exists and is confirmable
        const { rows: existing } = await pool.query(
          `
          SELECT status
          FROM orders
          WHERE id = $1
          `,
          [order_id]
        );

        if (!existing.length) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Order not found' }));
          return;
        }

        if (existing[0].status !== 'confirmed_pending_payment') {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'Order must be confirmed before scheduling',
          }));
          return;
        }

        // Update schedule + status
        const { rows } = await pool.query(
          `
          UPDATE orders
          SET
            scheduled_date = $1,
            scheduled_time = $2,
            status = 'scheduled'
          WHERE id = $3
          RETURNING
            id,
            status,
            scheduled_date,
            scheduled_time
          `,
          [scheduled_date, scheduled_time, order_id]
        );

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rows[0]));

      } catch (err) {
        console.error('[API] schedule error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to schedule order' }));
      }
    });

    return;
  }

  /* =========================
     LEGACY / TEMP
     CUSTOMER — CREATE ORDER
     POST /api/orders
     (kept for backward compatibility)
  ========================= */
  if (pathname === '/api/orders' && method === 'POST') {
    let body = '';

    req.on('data', chunk => (body += chunk));
    req.on('end', async () => {
      try {
        const { pickup_address, delivery_address } = JSON.parse(body);

        if (!pickup_address || !delivery_address) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'pickup_address and delivery_address are required',
          }));
          return;
        }

        const { rows } = await pool.query(
          `
          INSERT INTO orders (
            pickup_address,
            delivery_address,
            status
          )
          VALUES ($1, $2, 'new')
          RETURNING id, pickup_address, delivery_address, status, created_at
          `,
          [pickup_address, delivery_address]
        );

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rows[0]));
      } catch (err) {
        console.error('[API] create order:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to create order' }));
      }
    });

    return;
  }

  /* =========================
     DRIVER — GET ORDERS
     GET /api/driver/orders
  ========================= */
  if (pathname === '/api/driver/orders' && method === 'GET') {
    try {
      const { rows } = await pool.query(
        `
        SELECT id, pickup_address, delivery_address, status, created_at
        FROM orders
        ORDER BY created_at DESC
        LIMIT 25
        `
      );

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rows));
    } catch (err) {
      console.error('[API] driver/orders:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to fetch orders' }));
    }
    return;
  }

  /* =========================
     DRIVER — UPDATE STATUS
     PUT /api/driver/orders/:id/status
  ========================= */
  if (
    pathname.startsWith('/api/driver/orders/') &&
    pathname.endsWith('/status') &&
    method === 'PUT'
  ) {
    const parts = pathname.split('/');
    const orderId = parts[4];

    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', async () => {
      try {
        const { status } = JSON.parse(body);

        if (!status) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'status is required' }));
          return;
        }

        const { rows } = await pool.query(
          `
          UPDATE orders
          SET status = $1
          WHERE id = $2
          RETURNING id, pickup_address, delivery_address, status, created_at
          `,
          [status, orderId]
        );

        if (!rows.length) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Order not found' }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rows[0]));
      } catch (err) {
        console.error('[API] update status:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to update status' }));
      }
    });

    return;
  }

  /* =========================
     NOT FOUND
  ========================= */
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint not found' }));
}

module.exports = { handleAPI };
