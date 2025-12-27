const url = require('url');
const crypto = require('crypto');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

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
  ========================= */
  function calculatePricing({
    fragile = false,
    priority = false,
    sensitive = false,
    timeSensitive = false,
  }) {
    const DISTANCE_MILES = 10;
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
      distance_miles: DISTANCE_MILES,
      breakdown: {
        base_fee: BASE_FEE,
        mileage_cost: mileageCost,
        fragile_fee: fragile ? 10 : 0,
        priority_fee: priority ? 15 : 0,
        sensitive_fee: sensitive ? 12 : 0,
        time_sensitive_fee: timeSensitive ? 20 : 0,
      },
      total,
    };
  }

  /* =========================
     HEALTH
  ========================= */
  if (pathname === '/api/health' && method === 'GET') {
    await pool.query('SELECT 1');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  /* =========================
     QUOTE
  ========================= */
  if (pathname === '/api/quote' && method === 'POST') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const payload = JSON.parse(body);
      const pricing = calculatePricing(payload);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        quote_id: crypto.randomUUID(),
        ...pricing,
        expires_at: new Date(Date.now() + 15 * 60 * 1000),
      }));
    });
    return;
  }

  /* =========================
     CONFIRM
  ========================= */
  if (pathname === '/api/confirm' && method === 'POST') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', async () => {
      const { pickup_address, delivery_address } = JSON.parse(body);

      const { rows } = await pool.query(
        `INSERT INTO orders (pickup_address, delivery_address, status)
         VALUES ($1,$2,'confirmed_pending_payment')
         RETURNING id`,
        [pickup_address, delivery_address]
      );

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ order_id: rows[0].id }));
    });
    return;
  }

  /* =========================
     SCHEDULE
  ========================= */
  if (pathname === '/api/schedule' && method === 'POST') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', async () => {
      const { order_id, scheduled_date, scheduled_time } = JSON.parse(body);

      const { rows } = await pool.query(
        `UPDATE orders
         SET scheduled_date=$1, scheduled_time=$2, status='scheduled'
         WHERE id=$3
         RETURNING id, status, scheduled_date, scheduled_time`,
        [scheduled_date, scheduled_time, order_id]
      );

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rows[0]));
    });
    return;
  }

  /* =========================
     PAY  ✅ THIS WAS MISSING
  ========================= */
  if (pathname === '/api/pay' && method === 'POST') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', async () => {
      const { order_id } = JSON.parse(body);

      const { rows } = await pool.query(
        `SELECT status FROM orders WHERE id=$1`,
        [order_id]
      );

      if (!rows.length || rows[0].status !== 'scheduled') {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Order not schedulable for payment' }));
        return;
      }

      const pricing = calculatePricing({});

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: { name: 'Courier Delivery' },
            unit_amount: Math.round(pricing.total * 100),
          },
          quantity: 1,
        }],
        success_url: process.env.STRIPE_SUCCESS_URL,
        cancel_url: process.env.STRIPE_CANCEL_URL,
      });

      await pool.query(
        `UPDATE orders SET status='payment_pending' WHERE id=$1`,
        [order_id]
      );

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ checkout_url: session.url }));
    });
    return;
  }

  /* =========================
     DRIVER
  ========================= */
  if (pathname === '/api/driver/orders' && method === 'GET') {
    const { rows } = await pool.query(
      `SELECT * FROM orders ORDER BY created_at DESC LIMIT 25`
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rows));
    return;
  }

  res.writeHead(404);
  res.end();
}

module.exports = { handleAPI };
