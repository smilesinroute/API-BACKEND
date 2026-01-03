const url = require("url");
const crypto = require("crypto");

function json(res, code, payload) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const body = await readBody(req);
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function isValidEmail(email) {
  const e = String(email || "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function getAppOrigin() {
  return (process.env.APP_ORIGIN || "").trim() || "http://127.0.0.1:5175";
}

function buildRedirectUrls(order_id) {
  const origin = getAppOrigin();
  const rawSuccess = (process.env.STRIPE_SUCCESS_URL || "").trim();
  const rawCancel = (process.env.STRIPE_CANCEL_URL || "").trim();
  const oid = encodeURIComponent(String(order_id));

  const success_url = rawSuccess
    ? rawSuccess.replace("{{ORDER_ID}}", oid)
    : `${origin}/payment-success?order_id=${oid}`;

  const cancel_url = rawCancel
    ? rawCancel.replace("{{ORDER_ID}}", oid)
    : `${origin}/payment-cancel?order_id=${oid}`;

  return { success_url, cancel_url };
}

/**
 * API REQUEST HANDLER
 * - Plain Node HTTP (no Express)
 * - Uses pg pool from server.js
 */
async function handleAPI(req, res, pool) {
  const { pathname } = url.parse(req.url, true);
  const method = req.method;

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  // HEALTH
  if (pathname === "/api/health" && method === "GET") {
    try {
      await pool.query("SELECT 1");
      return json(res, 200, { status: "ok" });
    } catch {
      return json(res, 500, { status: "db_error" });
    }
  }

  // DISTANCE (server-side)
  if (pathname === "/api/distance" && method === "POST") {
    try {
      const { pickup, delivery } = await readJson(req);
      if (!pickup || !delivery) throw new Error("pickup and delivery are required");

      const { getDistanceMiles } = require("./src/lib/distanceMatrix");
      const distance_miles = await getDistanceMiles(pickup, delivery);

      return json(res, 200, { distance_miles });
    } catch (err) {
      console.error("[API] distance error:", err.message);
      return json(res, 400, { error: err.message });
    }
  }

  // QUOTE
  if (pathname === "/api/quote" && method === "POST") {
    try {
      const {
        service_type,
        region,
        vehicle_type,
        distance_miles = 0,
        fragile = false,
        priority = false,
        signatures = 0,
      } = await readJson(req);

      let sql, params;

      if (service_type === "courier") {
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
      } else if (service_type === "mobile_notary") {
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
        throw new Error("Invalid service_type");
      }

      const { rows } = await pool.query(sql, params);
      if (!rows.length) throw new Error("Pricing not configured");

      const p = rows[0];
      const breakdown = {};

      if (service_type === "courier") {
        breakdown.base = Number(p.base_rate || 0);
        breakdown.mileage = Number(p.per_mile_rate || 0) * Number(distance_miles);
        breakdown.fragile = fragile ? Number(p.fragile_fee || 0) : 0;
        breakdown.priority = priority ? Number(p.priority_fee || 0) : 0;
      }

      if (service_type === "mobile_notary") {
        breakdown.base = Number(p.base_rate || 0);
        breakdown.travel = Number(p.notary_travel_fee || 0);
        breakdown.signatures = Number(p.notary_per_signature_fee || 0) * Number(signatures);
        breakdown.convenience = Number(p.notary_convenience_fee || 0);
        breakdown.priority = priority ? Number(p.priority_fee || 0) : 0;
      }

      const total = Object.values(breakdown).reduce((sum, v) => sum + v, 0);

      return json(res, 200, {
        quote_id: crypto.randomUUID(),
        service_type,
        region,
        breakdown,
        total: Number(total.toFixed(2)),
        expires_at: new Date(Date.now() + 15 * 60 * 1000),
      });
    } catch (err) {
      console.error("[API] quote error:", err.message);
      return json(res, 500, { error: err.message });
    }
  }

  // CONFIRM ORDER (alias /api/orders)
  if ((pathname === "/api/confirm" || pathname === "/api/orders") && method === "POST") {
    try {
      const {
        pickup_address,
        delivery_address,
        service_type,
        total_amount,
        customer_email,
        distance_miles,
      } = await readJson(req);

      const { rows } = await pool.query(
        `
        INSERT INTO orders (
          pickup_address,
          delivery_address,
          service_type,
          total_amount,
          status,
          customer_email,
          distance_miles
        )
        VALUES ($1,$2,$3,$4,'confirmed_pending_payment',$5,$6)
        RETURNING id, status
        `,
        [
          pickup_address,
          delivery_address,
          service_type,
          total_amount,
          customer_email || null,
          distance_miles ?? null,
        ]
      );

      return json(res, 201, rows[0]);
    } catch (err) {
      console.error("[API] confirm error:", err.message);
      return json(res, 500, { error: err.message });
    }
  }

  /**
   * DISPATCH APPROVE
   * - Creates Stripe Checkout Session
   * - Emails customer payment link (best-effort)
   */
  if (pathname === "/api/dispatch/approve" && method === "POST") {
    try {
      const payload = await readJson(req);

      const order_id = payload.order_id;
      const customer_email = String(payload.customer_email || "").trim();
      const total_amount = Number(payload.total_amount);
      const service_type = payload.service_type || "courier";
      const pickup_address = payload.pickup_address || "";
      const delivery_address = payload.delivery_address || "";

      if (!order_id) throw new Error("order_id is required");
      if (!isValidEmail(customer_email)) throw new Error(`Invalid email address: ${customer_email || "(empty)"}`);
      if (!Number.isFinite(total_amount) || total_amount <= 0) throw new Error("total_amount must be a number > 0");

      const Stripe = require("stripe");
      const stripeKey = (process.env.STRIPE_SECRET_KEY || "").trim();
      if (!stripeKey) throw new Error("Missing STRIPE_SECRET_KEY on server");

      const stripe = new Stripe(stripeKey, { apiVersion: "2024-06-20" });
      const { success_url, cancel_url } = buildRedirectUrls(order_id);

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_email,
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: Math.round(total_amount * 100),
              product_data: {
                name: `Smiles in Route - ${service_type || "Order"}`,
                description:
                  pickup_address && delivery_address
                    ? `Pickup: ${pickup_address} | Dropoff: ${delivery_address}`.slice(0, 500)
                    : `Order ID: ${order_id}`.slice(0, 500),
              },
            },
            quantity: 1,
          },
        ],
        metadata: { order_id, service_type },
        success_url,
        cancel_url,
      });

      // Email customer (best-effort; don't fail the endpoint if SMTP fails)
      let emailed = false;
      try {
        const { sendMail } = require("./src/lib/mailer");
        const subject = "Payment link for your Smiles in Route order";
        const text =
          `Your order is approved by dispatch.\n\n` +
          `Order ID: ${order_id}\n` +
          `Amount: $${total_amount.toFixed(2)}\n` +
          (pickup_address ? `Pickup: ${pickup_address}\n` : "") +
          (delivery_address ? `Dropoff: ${delivery_address}\n` : "") +
          `\nPay here:\n${session.url}\n`;

        await sendMail({ to: customer_email, subject, text });
        emailed = true;
      } catch (emailErr) {
        console.error("[API] email send failed:", emailErr.message);
      }

      return json(res, 200, {
        ok: true,
        order_id,
        payment_url: session.url,
        session_id: session.id,
        emailed,
      });
    } catch (err) {
      console.error("[API] dispatch approve error:", err.message);
      return json(res, 400, { error: err.message });
    }
  }

  // FALLBACK
  return json(res, 404, { error: "Not found" });
}

module.exports = { handleAPI };
