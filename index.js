"use strict";

const url = require("url");
const crypto = require("crypto");

/* =========================
   Helpers
========================= */

function json(res, code, payload) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function sendText(res, code, text) {
  res.statusCode = code;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(text);
}

function isValidEmail(email) {
  const e = String(email || "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function getAppOrigin() {
  return (process.env.APP_ORIGIN || "").trim() || "http://127.0.0.1:5175";
}

function buildRedirectUrls(orderId) {
  const origin = getAppOrigin();
  const rawSuccess = (process.env.STRIPE_SUCCESS_URL || "").trim();
  const rawCancel = (process.env.STRIPE_CANCEL_URL || "").trim();
  const oid = encodeURIComponent(String(orderId));

  const success_url = rawSuccess
    ? rawSuccess.replace("{{ORDER_ID}}", oid)
    : `${origin}/payment-success?order_id=${oid}`;

  const cancel_url = rawCancel
    ? rawCancel.replace("{{ORDER_ID}}", oid)
    : `${origin}/payment-cancel?order_id=${oid}`;

  return { success_url, cancel_url };
}

function assertFiniteNumber(n, label) {
  const num = Number(n);
  if (!Number.isFinite(num)) throw new Error(`${label} must be a number`);
  return num;
}

function asTrimmedString(v) {
  return String(v ?? "").trim();
}

function asNullableTrimmedString(v) {
  const s = asTrimmedString(v);
  return s ? s : null;
}

/**
 * Read body with a hard limit (prevents accidental huge payloads).
 */
function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req) {
  // Accept missing content-type, but if present and not json, fail.
  const ct = String(req.headers["content-type"] || "");
  if (ct && !ct.toLowerCase().includes("application/json")) {
    throw new Error("Content-Type must be application/json");
  }

  const body = await readBody(req);
  if (!body) return {};

  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

/**
 * Insert order with optional columns (keeps API working if schema differs).
 * Returns { id, status }.
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
    scheduled_time,
  } = data;

  // Preferred insert (includes optional columns)
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
        scheduled_time,
        payment_status
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING id, status
      `,
      [
        pickup_address,
        delivery_address,
        service_type,
        total_amount,
        status,
        customer_email || null,
        distance_miles ?? null,
        scheduled_date || null,
        scheduled_time || null,
        "unpaid",
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
 * Best-effort confirmation email after /api/confirm.
 */
async function sendConfirmEmailSafe({
  to,
  orderId,
  service_type,
  pickup_address,
  delivery_address,
  scheduled_date,
  scheduled_time,
  total_amount,
}) {
  try {
    if (!isValidEmail(to)) return false;
    const { sendMail } = require("./src/lib/mailer");

    const subject = "Smiles in Route - Order Confirmed (Pending Dispatch Approval)";
    const text =
      `Thanks! We received your order and it's now confirmed.\n\n` +
      `Order ID: ${orderId}\n` +
      `Service: ${service_type}\n` +
      (pickup_address ? `Pickup: ${pickup_address}\n` : "") +
      (delivery_address ? `Dropoff: ${delivery_address}\n` : "") +
      `Scheduled: ${scheduled_date || "TBD"} ${scheduled_time || ""}\n\n` +
      `Estimated Total: $${Number(total_amount || 0).toFixed(2)}\n\n` +
      `Next step:\n` +
      `Dispatch will review and approve your order. Once approved, you'll receive a payment link by email.\n\n` +
      `-- Smiles in Route Transportation LLC\n`;

    await sendMail({ to, subject, text });
    return true;
  } catch (e) {
    console.warn("[EMAIL] confirm email failed:", e.message);
    return false;
  }
}

/**
 * Best-effort dispatch approve email with Stripe link.
 */
async function sendDispatchPaymentEmailSafe({
  to,
  orderId,
  service_type,
  pickup_address,
  delivery_address,
  total_amount,
  checkoutUrl,
}) {
  try {
    if (!isValidEmail(to)) return false;
    const { sendMail } = require("./src/lib/mailer");

    const subject = "Payment link for your Smiles in Route order";
    const text =
      `Your order is approved by dispatch.\n\n` +
      `Order ID: ${orderId}\n` +
      `Service: ${service_type}\n` +
      `Amount: $${Number(total_amount).toFixed(2)}\n` +
      (pickup_address ? `Pickup: ${pickup_address}\n` : "") +
      (delivery_address ? `Dropoff: ${delivery_address}\n` : "") +
      `\nPay here:\n${checkoutUrl}\n\n` +
      `-- Smiles in Route Transportation LLC\n`;

    await sendMail({ to, subject, text });
    return true;
  } catch (e) {
    console.error("[EMAIL] dispatch approve email failed:", e.message);
    return false;
  }
}

/* =========================
   API REQUEST HANDLER
========================= */

async function handleAPI(req, res, pool) {
  const { pathname } = url.parse(req.url, true);
  const method = req.method;

  // CORS (keep permissive for now; tighten later behind Cloudflare)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  // Optional: silence browser noise
  if (pathname === "/favicon.ico") {
    res.statusCode = 204;
    return res.end();
  }

  // HEALTH
  if (pathname === "/api/health" && method === "GET") {
    try {
      await pool.query("SELECT 1");
      return json(res, 200, { status: "ok" });
    } catch (e) {
      console.error("[API] health db_error:", e.message);
      return json(res, 500, { status: "db_error" });
    }
  }

  // DISTANCE
  if (pathname === "/api/distance" && method === "POST") {
    try {
      const { pickup, delivery } = await readJson(req);
      const p = asTrimmedString(pickup);
      const d = asTrimmedString(delivery);
      if (!p || !d) throw new Error("pickup and delivery are required");

      const { getDistanceMiles } = require("./src/lib/distanceMatrix");
      const distance_miles = await getDistanceMiles(p, d);

      return json(res, 200, { distance_miles });
    } catch (err) {
      console.error("[API] distance error:", err.message);
      return json(res, 400, { error: err.message });
    }
  }

  // QUOTE
  if (pathname === "/api/quote" && method === "POST") {
    try {
      const payload = await readJson(req);

      const service_type = asTrimmedString(payload.service_type);
      const region = asTrimmedString(payload.region);
      const vehicle_type = asTrimmedString(payload.vehicle_type);
      const distance_miles = payload.distance_miles ?? 0;
      const fragile = Boolean(payload.fragile);
      const priority = Boolean(payload.priority);
      const signatures = payload.signatures ?? 0;

      let sql, params;

      if (service_type === "courier") {
        if (!region) throw new Error("region is required");
        if (!vehicle_type) throw new Error("vehicle_type is required");
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
        if (!region) throw new Error("region is required");
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
        const miles = assertFiniteNumber(distance_miles, "distance_miles");
        breakdown.base = Number(p.base_rate || 0);
        breakdown.mileage = Number(p.per_mile_rate || 0) * Number(miles);
        breakdown.fragile = fragile ? Number(p.fragile_fee || 0) : 0;
        breakdown.priority = priority ? Number(p.priority_fee || 0) : 0;
      }

      if (service_type === "mobile_notary") {
        const sig = assertFiniteNumber(signatures, "signatures");
        breakdown.base = Number(p.base_rate || 0);
        breakdown.travel = Number(p.notary_travel_fee || 0);
        breakdown.signatures = Number(p.notary_per_signature_fee || 0) * Number(sig);
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
        expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      });
    } catch (err) {
      console.error("[API] quote error:", err.message);
      return json(res, 400, { error: err.message });
    }
  }

  // CONFIRM ORDER (alias /api/orders)
  if ((pathname === "/api/confirm" || pathname === "/api/orders") && method === "POST") {
    try {
      const payload = await readJson(req);

      const pickup_address = asTrimmedString(payload.pickup_address);
      const delivery_address = asTrimmedString(payload.delivery_address);
      const service_type = asTrimmedString(payload.service_type);
      const total_amount = assertFiniteNumber(payload.total_amount, "total_amount");

      const customer_email = asTrimmedString(payload.customer_email);
      const distance_miles =
        payload.distance_miles !== undefined && payload.distance_miles !== null
          ? Number(payload.distance_miles)
          : null;

      const scheduled_date = asNullableTrimmedString(payload.scheduled_date);
      const scheduled_time = asNullableTrimmedString(payload.scheduled_time);

      if (!pickup_address || !delivery_address) throw new Error("pickup_address and delivery_address are required");
      if (!service_type) throw new Error("service_type is required");
      if (total_amount <= 0) throw new Error("total_amount must be > 0");
      if (customer_email && !isValidEmail(customer_email)) throw new Error(`Invalid email address: ${customer_email}`);
      if (distance_miles !== null && !Number.isFinite(distance_miles)) throw new Error("distance_miles must be numeric");

      const created = await insertOrderSafe(pool, {
        pickup_address,
        delivery_address,
        service_type,
        total_amount: Number(total_amount),
        status: "confirmed_pending_payment",
        customer_email: customer_email || null,
        distance_miles,
        scheduled_date,
        scheduled_time,
      });

      const emailed_confirmation = await sendConfirmEmailSafe({
        to: customer_email,
        orderId: created.id,
        service_type,
        pickup_address,
        delivery_address,
        scheduled_date,
        scheduled_time,
        total_amount,
      });

      return json(res, 201, { ...created, emailed_confirmation });
    } catch (err) {
      console.error("[API] confirm error:", err.message);
      return json(res, 400, { error: err.message });
    }
  }

  // DISPATCH APPROVE
  if (pathname === "/api/dispatch/approve" && method === "POST") {
    const client = await pool.connect();
    try {
      const payload = await readJson(req);
      const orderId = asTrimmedString(payload.order_id);
      if (!orderId) throw new Error("order_id is required");

      await client.query("BEGIN");

      const { rows } = await client.query(
        `
        SELECT
          id,
          status,
          service_type,
          total_amount,
          customer_email,
          pickup_address,
          delivery_address,
          stripe_session_id,
          stripe_checkout_url,
          payment_status
        FROM orders
        WHERE id = $1
        FOR UPDATE
        `,
        [orderId]
      );

      if (!rows.length) throw new Error("Order not found");

      const order = rows[0];

      if (order.status !== "confirmed_pending_payment") {
        throw new Error(`Order status must be confirmed_pending_payment (current: ${order.status})`);
      }

      // If already has a session, return it instead of failing (idempotent)
      if (order.stripe_session_id && order.stripe_checkout_url) {
        await client.query("COMMIT");
        const emailed = await sendDispatchPaymentEmailSafe({
          to: String(order.customer_email || "").trim(),
          orderId,
          service_type: String(order.service_type || "courier"),
          pickup_address: String(order.pickup_address || ""),
          delivery_address: String(order.delivery_address || ""),
          total_amount: Number(order.total_amount || 0),
          checkoutUrl: String(order.stripe_checkout_url),
        });

        return json(res, 200, {
          ok: true,
          order_id: orderId,
          payment_url: order.stripe_checkout_url,
          session_id: order.stripe_session_id,
          emailed,
          reused_existing_session: true,
        });
      }

      const customer_email = String(order.customer_email || "").trim();
      if (!isValidEmail(customer_email)) throw new Error("Order is missing a valid customer_email");

      const total_amount = assertFiniteNumber(order.total_amount, "total_amount");
      if (total_amount <= 0) throw new Error("Order total_amount must be > 0");

      const Stripe = require("stripe");
      const stripeKey = asTrimmedString(process.env.STRIPE_SECRET_KEY);
      if (!stripeKey) throw new Error("Missing STRIPE_SECRET_KEY on server");

      const stripe = new Stripe(stripeKey, { apiVersion: "2024-06-20" });
      const { success_url, cancel_url } = buildRedirectUrls(orderId);

      const pickup_address = String(order.pickup_address || "");
      const delivery_address = String(order.delivery_address || "");
      const service_type = String(order.service_type || "courier");

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
                    : `Order ID: ${orderId}`.slice(0, 500),
              },
            },
            quantity: 1,
          },
        ],
        metadata: { order_id: orderId, service_type },
        success_url,
        cancel_url,
      });

      await client.query(
        `
        UPDATE orders
        SET
          stripe_session_id = $2,
          stripe_checkout_url = $3,
          payment_status = 'pending'
        WHERE id = $1
        `,
        [orderId, session.id, session.url]
      );

      await client.query("COMMIT");

      const emailed = await sendDispatchPaymentEmailSafe({
        to: customer_email,
        orderId,
        service_type,
        pickup_address,
        delivery_address,
        total_amount,
        checkoutUrl: session.url,
      });

      return json(res, 200, {
        ok: true,
        order_id: orderId,
        payment_url: session.url,
        session_id: session.id,
        emailed,
      });
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {}
      console.error("[API] dispatch approve error:", err.message);
      return json(res, 400, { error: err.message });
    } finally {
      client.release();
    }
  }

  return json(res, 404, { error: "Not found" });
}

module.exports = { handleAPI };
