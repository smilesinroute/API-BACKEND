const url = require('url');
const crypto = require('crypto');
const { sendPaymentEmail } = require('./src/email/sendPaymentEmail');

/*
========================================
 API REQUEST HANDLER
 - Plain Node HTTP (no Express)
 - Uses pg pool from server.js
========================================
*/
async function handleAPI(req, res, pool) {
  const { pathname } = url.parse(req.url, true);
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
     HEALTH
  ========================= */
  if (pathname === '/api/health' && method === 'GET') {
    try {
      await pool.query('SELECT 1');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'db_error' }));
    }
    return;
  }

  /* =========================
     QUOTE
  ========================= */
  if (pathname === '/api/quote' && method === 'POST') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', async () => {
      try {
        const {
          service_type,
          region,
          vehicle_type,
          distance_miles = 0,
          fragile = false,
          priority = false,
          signatures = 0
        } = JSON.parse(body);

        let sql, params;

        if (service_type === 'courier') {
          sql = `
            SELECT *
            FROM pricing_config
            WHERE service_type='courier'
              AND region=$1
              AND vehicle_type=$2
              AND active=true
            LIMIT 1
          `;
          params = [region, vehicle_type];
        } else if (service_type === 'mobile_notary') {
          sql = `
            SELECT *
            FROM pricing_config
            WHERE service_type='mobile_notary'
              AND region=$1
              AND active=true
            LIMIT 1
          `;
          params = [region];
        } else {
          throw new Error('Invalid service_type');
        }

        const { rows } = await pool.query(sql, params);
        if (!rows.length) throw new Error('Pricing not configured');

        const p = rows[0];
        const breakdown = {};
        let total = 0;

        if (service_type === 'courier') {
          breakdown.base = Number(p.base_rate || 0);
          breakdown.mileage = Number(p.per_mile_rate || 0) * Number(distance_miles);
          breakdown.fragile = fragile ? Number(p.fragile_fee || 0) : 0;
          breakdown.priority = priority ? Number(p.priority_fee || 0) : 0;
        }

        if (service_type === 'mobile_notary') {
          breakdown.base = Number(p.base_rate || 0);
          breakdown.travel = Number(p.notary_travel_fee || 0);
          breakdown.signatures =
            Number(p.notary_per_signature_fee || 0) * Number(signatures);
          breakdown.convenience = Number(p.notary_convenience_fee || 0);
          breakdown.priority = priority ? Number(p.priority_fee || 0) : 0;
        }

        total = Object.values(breakdown).reduce((a, b) => a + b, 0);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          quote_id: crypto.randomUUID(),
          service_type,
          region,
          breakdown,
          total: Number(total.toFixed(2)),
          expires_at: new Date(Date.now() + 15 * 60 * 1000)
        }));
      } catch (err) {
        console.error('[API] quote error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  /* =========================
     CONFIRM ORDER
  ========================= */
  if (pathname === '/api/confirm' && method === 'POST') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', async () => {
      try {
        const {
          pickup_address,
          delivery_address,
          service_type,
          total_amount
        } = JSON.parse(body);

        const { rows } = await pool.query(
          `
          INSERT INTO orders (
            pickup_address,
            delivery_address,
            service_type,
            total_amount,
            status
          )
          VALUES ($1,$2,$3,$4,'confirmed_pending_payment')
          RETURNING id, status
          `,
          [pickup_address, delivery_address, service_type, total_amount]
        );

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rows[0]));
      } catch (err) {
        console.error('[API] confirm error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
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
        `
        UPDATE orders
        SET scheduled_date=$1,
            scheduled_time=$2,
            status='scheduled'
        WHERE id=$3
        RETURNING *
        `,
        [scheduled_date, scheduled_time, order_id]
      );

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rows[0]));
    });
    return;
  }

  /* =========================
     PAY + EMAIL
  ========================= */
  if (pathname === '/api/pay' && method === 'POST') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', async () => {
      try {
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        const { order_id } = JSON.parse(body);

        const { rows } = await pool.query(
          `SELECT * FROM orders WHERE id=$1 AND status='scheduled'`,
          [order_id]
        );

        if (!rows.length) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Order not ready for payment' }));
          return;
        }

        const o = rows[0];

        const session = await stripe.checkout.sessions.create({
          mode: 'payment',
          payment_method_types: ['card'],
          line_items: [{
            price_data: {
              currency: 'usd',
              product_data: { name: 'Smiles in Route Service' },
              unit_amount: Math.round(Number(o.total_amount) * 100)
            },
            quantity: 1
          }],
          success_url: process.env.STRIPE_SUCCESS_URL,
          cancel_url: process.env.STRIPE_CANCEL_URL
        });

        await pool.query(
          `UPDATE orders SET status='payment_pending' WHERE id=$1`,
          [order_id]
        );

        // Email failure should NOT block payment
        try {
          await sendPaymentEmail({
            to: o.customer_email || process.env.EMAIL_FROM,
            customerName: 'Customer',
            serviceType: o.service_type,
            pickup: o.pickup_address,
            delivery: o.delivery_address,
            date: o.scheduled_date,
            time: o.scheduled_time,
            distance: o.distance_miles || '—',
            total: o.total_amount,
            checkoutUrl: session.url
          });
        } catch (emailErr) {
          console.warn('[EMAIL] failed:', emailErr.message);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ checkout_url: session.url }));
      } catch (err) {
        console.error('[API] pay error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
}

module.exports = { handleAPI };
