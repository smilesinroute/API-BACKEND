const url = require('url');
const crypto = require('crypto');

function json(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function setCors(req, res) {
  // Keep open while you build; tighten later if you want
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const body = await readBody(req);
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('Invalid JSON body');
  }
}

function isValidEmail(email) {
  const e = String(email || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function getAppOrigin() {
  // Production should be your Netlify origin; local can be localhost
  return (process.env.APP_ORIGIN || '').trim() || 'http://localhost:5175';
}

function buildRedirectUrls(order_id) {
  const origin = getAppOrigin();
  const rawSuccess = (process.env.STRIPE_SUCCESS_URL || '').trim();
  const rawCancel  = (process.env.STRIPE_CANCEL_URL  || '').trim();
  const oid = encodeURIComponent(String(order_id));

  const success_url = rawSuccess
    ? rawSuccess.replace('{{ORDER_ID}}', oid)
    : `${origin}/payment-success?order_id=${oid}`;

  const cancel_url = rawCancel
    ? rawCancel.replace('{{ORDER_ID}}', oid)
    : `${origin}/payment-cancel?order_id=${oid}`;

  return { success_url, cancel_url };
}

/**
 * INSERT that tolerates schema differences (optional columns)
 */
async function insertOrderSafe(pool, data) {
  const {
    pickup_address,
    delivery_address,
    service_type,
    total_amount,
    status,
    customer_email,
    distance_miles,
    scheduled_date,
    scheduled_time
  } = data;

  // Try extended insert first
  try {
    const { rows } = await pool.query(
      `
      INSERT INTO orders (
        pickup_address,
        delivery_address,
        service_type,
        total_amount,
        status,
        customer_email,
        distance_miles,
        scheduled_date,
        scheduled_time
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING id, status
      `,
      [
        pickup_address,
        delivery_address,
        service_type,
        total_amount,
        status,
        customer_email || null,
        (distance_miles ?? null),
        scheduled_date || null,
        scheduled_time || null
      ]
    );
    return rows[0];
  } catch {
    // Fallback minimal insert
    const { rows } = await pool.query(
      `
      INSERT INTO orders (
        pickup_address,
        delivery_address,
        service_type,
        total_amount,
        status
      )
      VALUES ($1,$2,$3,$4,$5)
      RETURNING id, status
      `,
      [pickup_address, delivery_address, service_type, total_amount, status]
    );
    return rows[0];
  }
}

/**
 * UPDATE that tolerates schema differences (optional columns)
 */
async function updateOrderSafe(pool, order_id, patch) {
  const status = patch.status;
  const stripe_session_id = patch.stripe_session_id ?? null;
  const stripe_checkout_url = patch.stripe_checkout_url ?? null;
  const scheduled_date = patch.scheduled_date ?? null;
  const scheduled_time = patch.scheduled_time ?? null;

  // Try extended update
  try {
    const { rows } = await pool.query(
      `
      UPDATE orders
      SET
        status = $2,
        stripe_session_id = COALESCE($3, stripe_session_id),
        stripe_checkout_url = COALESCE($4, stripe_checkout_url),
        scheduled_date = COALESCE($5, scheduled_date),
        scheduled_time = COALESCE($6, scheduled_time)
      WHERE id = $1
      RETURNING *
      `,
      [order_id, status, stripe_session_id, stripe_checkout_url, scheduled_date, scheduled_time]
    );
    return rows[0] || null;
  } catch {
    // Fallback status-only update
    const { rows } = await pool.query(
      `
      UPDATE orders
      SET status = $2
      WHERE id = $1
      RETURNING *
      `,
      [order_id, status]
    );
    return rows[0] || null;
  }
}

function requireStripe() {
  const Stripe = require('stripe');
  const stripeKey = (process.env.STRIPE_SECRET_KEY || '').trim();
  if (!stripeKey) throw new Error('Missing STRIPE_SECRET_KEY');
  return new Stripe(stripeKey, { apiVersion: '2024-06-20' });
}

/*
========================================
 API REQUEST HANDLER (Plain Node HTTP)
========================================
*/
async function handleAPI(req, res, pool) {
  const { pathname } = url.parse(req.url, true);
  const method = req.method;

  setCors(req, res);

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
      return json(res, 200, { status: 'ok' });
    } catch {
      return json(res, 500, { status: 'db_error' });
    }
  }

  /* =========================
     DISTANCE (server-side)
  ========================= */
  if (pathname === '/api/distance' && method === 'POST') {
    try {
      const { pickup, delivery } = await readJson(req);
      if (!pickup || !delivery) throw new Error('pickup and delivery are required');

      const { getDistanceMiles } = require('./src/lib/distanceMatrix');
      const distance_miles = await getDistanceMiles(pickup, delivery);

      return json(res, 200, { distance_miles });
    } catch (err) {
      console.error('[API] distance error:', err.message);
      return json(res, 400, { error: err.message });
    }
  }

  /* =========================
     QUOTE
  ========================= */
  if (pathname === '/api/quote' && method === 'POST') {
    try {
      const {
        service_type,
        region,
        vehicle_type,
        distance_miles = 0,
        fragile = false,
        priority = false,
        signatures = 0
      } = await readJson(req);

      let sql, params;

      if (service_type === 'courier') {
        sql = `
          SELECT *
          FROM pricing_config
          WHERE service_type = 'courier'
            AND region = $1
            AND vehicle_type = $2
            AND active = true
          LIMIT 1
        `;
        params = [region, vehicle_type];
      } else if (service_type === 'mobile_notary') {
        sql = `
          SELECT *
          FROM pricing_config
          WHERE service_type = 'mobile_notary'
            AND region = $1
            AND active = true
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

      if (service_type === 'courier') {
        breakdown.base = Number(p.base_rate || 0);
        breakdown.mileage = Number(p.per_mile_rate || 0) * Number(distance_miles || 0);
        breakdown.fragile = fragile ? Number(p.fragile_fee || 0) : 0;
        breakdown.priority = priority ? Number(p.priority_fee || 0) : 0;
      }

      if (service_type === 'mobile_notary') {
        breakdown.base = Number(p.base_rate || 0);
        breakdown.travel = Number(p.notary_travel_fee || 0);
        breakdown.signatures = Number(p.notary_per_signature_fee || 0) * Number(signatures || 0);
        breakdown.convenience = Number(p.notary_convenience_fee || 0);
        breakdown.priority = priority ? Number(p.priority_fee || 0) : 0;
      }

      const total = Object.values(breakdown).reduce((sum, v) => sum + Number(v || 0), 0);

      return json(res, 200, {
        quote_id: crypto.randomUUID(),
        service_type,
        region,
        breakdown,
        total: Number(total.toFixed(2)),
        expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString()
      });
    } catch (err) {
      console.error('[API] quote error:', err.message);
      return json(res, 400, { error: err.message });
    }
  }

  /* =========================
     CONFIRM ORDER  (alias: /api/orders)
  ========================= */
  if ((pathname === '/api/confirm' || pathname === '/api/orders') && method === 'POST') {
    try {
      const {
        pickup_address,
        delivery_address,
        service_type,
        total_amount,
        customer_email,
        distance_miles
      } = await readJson(req);

      if (!pickup_address || !delivery_address) throw new Error('pickup_address and delivery_address are required');
      if (!service_type) throw new Error('service_type is required');
      const amt = Number(total_amount);
      if (!Number.isFinite(amt) || amt <= 0) throw new Error('total_amount must be a number > 0');

      const row = await insertOrderSafe(pool, {
        pickup_address,
        delivery_address,
        service_type,
        total_amount: amt,
        status: 'confirmed_pending_payment',
        customer_email: customer_email || null,
        distance_miles: (distance_miles ?? null)
      });

      return json(res, 201, row);
    } catch (err) {
      console.error('[API] confirm error:', err.message);
      return json(res, 400, { error: err.message });
    }
  }

  /* =========================
     SCHEDULE
  ========================= */
  if (pathname === '/api/schedule' && method === 'POST') {
    try {
      const { order_id, scheduled_date, scheduled_time } = await readJson(req);
      if (!order_id) throw new Error('order_id is required');
      if (!scheduled_date || !scheduled_time) throw new Error('scheduled_date and scheduled_time are required');

      const row = await updateOrderSafe(pool, order_id, {
        status: 'scheduled',
        scheduled_date,
        scheduled_time
      });

      return json(res, 200, row || { ok: true });
    } catch (err) {
      console.error('[API] schedule error:', err.message);
      return json(res, 400, { error: err.message });
    }
  }

  /* =========================
     PAY (optional fallback) - creates Checkout session + stores session info
  ========================= */
  if (pathname === '/api/pay' && method === 'POST') {
    try {
      const { order_id } = await readJson(req);
      if (!order_id) throw new Error('order_id is required');

      const stripe = requireStripe();
      const { success_url, cancel_url } = buildRedirectUrls(order_id);

      // Try to load order (if table supports it)
      let order = null;
      try {
        const r = await pool.query(`SELECT * FROM orders WHERE id = $1 LIMIT 1`, [order_id]);
        order = r.rows[0] || null;
      } catch {}

      const total_amount = Number(order?.total_amount ?? 0);
      if (!Number.isFinite(total_amount) || total_amount <= 0) throw new Error('Order total_amount not found/invalid');

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer_email: order?.customer_email || undefined,
        line_items: [
          {
            price_data: {
              currency: 'usd',
              unit_amount: Math.round(total_amount * 100),
              product_data: { name: 'Smiles in Route Service' }
            },
            quantity: 1
          }
        ],
        metadata: { order_id, service_type: order?.service_type || 'service' },
        success_url,
        cancel_url
      });

      await updateOrderSafe(pool, order_id, {
        status: 'payment_pending',
        stripe_session_id: session.id,
        stripe_checkout_url: session.url
      });

      return json(res, 200, { checkout_url: session.url, session_id: session.id });
    } catch (err) {
      console.error('[API] pay error:', err.message);
      return json(res, 400, { error: err.message });
    }
  }

  /* =========================
     DISPATCH APPROVE
     - creates Stripe link + emails customer
  ========================= */
  if (pathname === '/api/dispatch/approve' && method === 'POST') {
    try {
      const payload = await readJson(req);

      const order_id = payload.order_id;
      const customer_email = String(payload.customer_email || '').trim();
      const total_amount = Number(payload.total_amount);
      const service_type = payload.service_type || 'courier';
      const pickup_address = payload.pickup_address || '';
      const delivery_address = payload.delivery_address || '';

      if (!order_id) throw new Error('order_id is required');
      if (!isValidEmail(customer_email)) throw new Error(`Invalid email address: ${customer_email || '(empty)'}`);
      if (!Number.isFinite(total_amount) || total_amount <= 0) throw new Error('total_amount must be a number > 0');

      const stripe = requireStripe();
      const { success_url, cancel_url } = buildRedirectUrls(order_id);

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer_email,
        line_items: [
          {
            price_data: {
              currency: 'usd',
              unit_amount: Math.round(total_amount * 100),
              product_data: {
                name: `Smiles in Route - ${service_type || 'Order'}`,
                description: (pickup_address && delivery_address)
                  ? `Pickup: ${pickup_address} | Dropoff: ${delivery_address}`.slice(0, 500)
                  : `Order: ${String(order_id)}`.slice(0, 500)
              }
            },
            quantity: 1
          }
        ],
        metadata: { order_id: String(order_id), service_type: String(service_type) },
        success_url,
        cancel_url
      });

      // Best-effort store session info on the order (won't block if schema differs)
      try {
        await updateOrderSafe(pool, order_id, {
          status: 'dispatch_approved_payment_sent',
          stripe_session_id: session.id,
          stripe_checkout_url: session.url
        });
      } catch {}

      // Email (best effort)
      let emailed = false;
      try {
        const { sendMail } = require('./src/lib/mailer');
        const subject = 'Payment link for your Smiles in Route order';
        const text =
`Your order has been approved by dispatch.

Order ID: ${order_id}
Service: ${service_type}
Pickup: ${pickup_address}
Dropoff: ${delivery_address}
Amount: $${total_amount.toFixed(2)}

Pay here:
${session.url}
`;
        await sendMail({ to: customer_email, subject, text });
        emailed = true;
      } catch (emailErr) {
        console.error('[API] email send failed:', emailErr.message);
      }

      return json(res, 200, {
        ok: true,
        order_id,
        payment_url: session.url,
        session_id: session.id,
        emailed
      });
    } catch (err) {
      console.error('[API] dispatch approve error:', err.message);
      return json(res, 400, { error: err.message });
    }
  }

  /* =========================
     FALLBACK
  ========================= */
  return json(res, 404, { error: 'Not found' });
}

module.exports = { handleAPI };
