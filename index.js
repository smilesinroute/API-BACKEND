"use strict";

/**
 * Smiles in Route — Main API Router (Plain Node.js)
 * =====================================================
 * - No Express
 * - Routes by pathname + method
 * - Uses ONE shared Postgres pool (Supabase Postgres)
 *
 * Includes:
 * - Driver routes (priority)
 * - Health
 * - Distance
 * - Quote
 * - Scheduling (available slots + holds)
 * - Orders (confirm/create)
 * - Dispatch approve (Stripe Checkout)
 */

const url = require("url");
const crypto = require("crypto");

/* ======================================================
   DRIVER ROUTES (PRIORITY)
====================================================== */
const { handleDriverRoutes } = require("./src/drivers/driverRoutes");
const { handleDriverOrders } = require("./src/drivers/driverOrders");
const { handleDriverAssignments } = require("./src/drivers/driverAssignments");
const { handleDriverProof } = require("./src/drivers/driverProof");

/* ======================================================
   RESPONSE HELPERS
====================================================== */
function json(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(text);
}

/* ======================================================
   VALIDATION & SANITIZATION
====================================================== */
function isValidEmail(email) {
  const value = String(email || "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function asTrimmedString(value) {
  return String(value ?? "").trim();
}

function asNullableTrimmedString(value) {
  const v = asTrimmedString(value);
  return v || null;
}

function assertFiniteNumber(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${label} must be a number`);
  return n;
}

function assertIsoDate(value, label = "date") {
  const v = asTrimmedString(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`${label} must be YYYY-MM-DD`);
  return v;
}

function assertHHMM(value, label = "time") {
  const v = asTrimmedString(value);
  if (!/^\d{2}:\d{2}$/.test(v)) throw new Error(`${label} must be HH:MM`);
  const [hh, mm] = v.split(":").map((x) => Number(x));
  if (!(hh >= 0 && hh <= 23 && (mm === 0 || mm === 30))) {
    // we allow :00/:30 for courier/delivery. notary uses :00 but this is still safe
    throw new Error(`${label} must be a valid 24h time (HH:MM)`);
  }
  return v;
}

function isWeekendISODate(isoDate) {
  const d = new Date(`${isoDate}T00:00:00`);
  const day = d.getDay(); // 0 Sun .. 6 Sat
  return day === 0 || day === 6;
}

/* ======================================================
   STRIPE REDIRECT HELPERS
====================================================== */
function getAppOrigin() {
  return asTrimmedString(process.env.APP_ORIGIN) || "http://127.0.0.1:5175";
}

function buildRedirectUrls(orderId) {
  const origin = getAppOrigin();
  const successTpl = asTrimmedString(process.env.STRIPE_SUCCESS_URL);
  const cancelTpl = asTrimmedString(process.env.STRIPE_CANCEL_URL);
  const oid = encodeURIComponent(String(orderId));

  return {
    success_url: successTpl
      ? successTpl.replace("{{ORDER_ID}}", oid)
      : `${origin}/payment-success?order_id=${oid}`,
    cancel_url: cancelTpl
      ? cancelTpl.replace("{{ORDER_ID}}", oid)
      : `${origin}/payment-cancel?order_id=${oid}`,
  };
}

/* ======================================================
   BODY PARSERS (RAW NODE)
====================================================== */
function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const contentType = String(req.headers["content-type"] || "");
  if (contentType && !contentType.toLowerCase().includes("application/json")) {
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

/* ======================================================
   DATABASE HELPERS
====================================================== */
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
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'unpaid')
      RETURNING id, status
      `,
      [
        pickup_address,
        delivery_address,
        service_type,
        total_amount,
        status,
        customer_email,
        distance_miles,
        scheduled_date,
        scheduled_time,
      ]
    );
    return rows[0];
  } catch {
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

/* ======================================================
   EMAIL HELPERS (BEST-EFFORT)
====================================================== */
async function sendConfirmEmailSafe(details) {
  try {
    if (!isValidEmail(details.to)) return false;

    const { sendMail } = require("./src/lib/mailer");

    const text =
      `Order confirmed\n\n` +
      `Order ID: ${details.orderId}\n` +
      `Service: ${details.service_type}\n` +
      `Pickup: ${details.pickup_address || "N/A"}\n` +
      `Dropoff: ${details.delivery_address || "N/A"}\n` +
      `Scheduled: ${details.scheduled_date || "TBD"} ${details.scheduled_time || ""}\n\n` +
      `Estimated Total: $${Number(details.total_amount).toFixed(2)}\n\n` +
      `Dispatch will review and send payment instructions.\n\n` +
      `— Smiles in Route Transportation LLC`;

    await sendMail({
      to: details.to,
      subject: "Smiles in Route – Order Confirmed",
      text,
    });

    return true;
  } catch (err) {
    console.warn("[EMAIL] confirmation failed:", err.message);
    return false;
  }
}

async function sendDispatchPaymentEmailSafe(details) {
  try {
    if (!isValidEmail(details.to)) return false;

    const { sendMail } = require("./src/lib/mailer");

    const text =
      `Your order has been approved.\n\n` +
      `Order ID: ${details.orderId}\n` +
      `Service: ${details.service_type}\n` +
      `Amount: $${Number(details.total_amount).toFixed(2)}\n\n` +
      `Pay here:\n${details.checkoutUrl}\n\n` +
      `— Smiles in Route Transportation LLC`;

    await sendMail({
      to: details.to,
      subject: "Smiles in Route – Payment Link",
      text,
    });

    return true;
  } catch (err) {
    console.warn("[EMAIL] dispatch payment failed:", err.message);
    return false;
  }
}

/* ======================================================
   SCHEDULING HELPERS
====================================================== */
/**
 * Windows:
 * - standard = normal business hours
 * - after_hours = evenings
 * - weekend = weekend window (only valid if date is Sat/Sun)
 *
 * Query options:
 * - serviceType=delivery|notary (delivery == courier scheduling)
 * - window=standard|after_hours|weekend
 */
function generateTimeSlots(serviceType, window) {
  const slots = [];

  const type = serviceType === "notary" ? "notary" : "delivery";
  const w = window || "standard";

  let startHour, endHour, intervalMinutes;

  if (type === "notary") {
    intervalMinutes = 60;

    if (w === "after_hours") {
      startHour = 17;
      endHour = 19;
    } else if (w === "weekend") {
      startHour = 10;
      endHour = 14;
    } else {
      startHour = 9;
      endHour = 17;
    }
  } else {
    intervalMinutes = 30;

    if (w === "after_hours") {
      startHour = 18;
      endHour = 21;
    } else if (w === "weekend") {
      startHour = 10;
      endHour = 16;
    } else {
      startHour = 8;
      endHour = 18;
    }
  }

  for (let h = startHour; h < endHour; h++) {
    for (let m = 0; m < 60; m += intervalMinutes) {
      slots.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
  }

  return slots;
}

/* ======================================================
   MAIN API HANDLER
====================================================== */
async function handleAPI(req, res, pool) {
  const { pathname, query } = url.parse(req.url, true);
  const method = req.method;

  /* ---------- CORS ---------- */
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (pathname === "/favicon.ico") {
    res.statusCode = 204;
    return res.end();
  }

  /* ======================================================
     DRIVER ROUTES (run BEFORE customer endpoints)
  ====================================================== */
  try {
    if (await handleDriverRoutes(req, res, pool, pathname, method)) return;
    if (await handleDriverOrders(req, res, pool, pathname, method)) return;
    if (await handleDriverAssignments(req, res, pool, pathname, method)) return;
    if (await handleDriverProof(req, res, pool, pathname, method)) return;
  } catch (e) {
    console.error("[DRIVER] routing error:", e.message);
    return json(res, 500, { error: "Driver routing error" });
  }

  /* ---------- HEALTH ---------- */
  if (pathname === "/api/health" && method === "GET") {
    try {
      await pool.query("SELECT 1");
      return json(res, 200, { status: "ok" });
    } catch {
      return json(res, 500, { status: "db_error" });
    }
  }

  /* ======================================================
     SCHEDULING — GET AVAILABLE SLOTS
     GET /api/available-slots/:date?serviceType=delivery|notary&window=standard|after_hours|weekend
  ====================================================== */
  if (pathname.startsWith("/api/available-slots/") && method === "GET") {
    try {
      const date = assertIsoDate(pathname.replace("/api/available-slots/", ""), "date");
      const serviceType = asTrimmedString(query.serviceType || "delivery") || "delivery";
      const window = asTrimmedString(query.window || "standard") || "standard";

      if (!["standard", "after_hours", "weekend"].includes(window)) {
        throw new Error("window must be one of: standard, after_hours, weekend");
      }

      if (window === "weekend" && !isWeekendISODate(date)) {
        throw new Error("window=weekend is only valid for Saturday/Sunday dates");
      }

      let bookedTimes = [];

      if (serviceType === "notary") {
        const result = await pool.query(
          `
          SELECT appointment_time
          FROM notary_appointments
          WHERE appointment_date = $1
            AND COALESCE(status,'') <> 'cancelled'
          `,
          [date]
        );
        bookedTimes = result.rows.map((r) => String(r.appointment_time).slice(0, 5));
      } else {
        const result = await pool.query(
          `
          SELECT delivery_time
          FROM deliveries
          WHERE delivery_date = $1
            AND COALESCE(status,'') <> 'cancelled'
          `,
          [date]
        );
        bookedTimes = result.rows.map((r) => String(r.delivery_time).slice(0, 5));
      }

      const availableSlots = generateTimeSlots(serviceType, window).filter(
        (slot) => !bookedTimes.includes(slot)
      );

      return json(res, 200, {
        date,
        serviceType: serviceType === "notary" ? "notary" : "delivery",
        window,
        availableSlots,
        bookedSlots: bookedTimes,
      });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  /* ======================================================
     SCHEDULING — CREATE HOLD
     POST /api/appointments
     {
       "serviceType": "delivery" | "notary",
       "date": "YYYY-MM-DD",
       "time": "HH:MM",
       "window": "standard" | "after_hours" | "weekend" (optional)
     }
  ====================================================== */
  if (pathname === "/api/appointments" && method === "POST") {
    try {
      const body = await readJson(req);

      const serviceType = asTrimmedString(body.serviceType || "delivery") || "delivery";
      const date = assertIsoDate(body.date, "date");
      const time = assertHHMM(body.time, "time");
      const window = asTrimmedString(body.window || "standard") || "standard";

      if (!["standard", "after_hours", "weekend"].includes(window)) {
        throw new Error("window must be one of: standard, after_hours, weekend");
      }
      if (window === "weekend" && !isWeekendISODate(date)) {
        throw new Error("window=weekend is only valid for Saturday/Sunday dates");
      }

      // Prevent double-booking: check if already booked
      if (serviceType === "notary") {
        const exists = await pool.query(
          `
          SELECT 1
          FROM notary_appointments
          WHERE appointment_date = $1
            AND appointment_time = $2
            AND COALESCE(status,'') <> 'cancelled'
          LIMIT 1
          `,
          [date, time]
        );
        if (exists.rows.length) throw new Error("Slot is already booked");

        await pool.query(
          `
          INSERT INTO notary_appointments (
            appointment_date,
            appointment_time,
            status,
            customer_name,
            customer_email,
            customer_phone,
            appointment_address
          )
          VALUES ($1,$2,'scheduled',$3,$4,$5,$6)
          `,
          [date, time, "Scheduling Hold", "pending@smilesinroute.delivery", "0000000000", "TBD"]
        );
      } else {
        const exists = await pool.query(
          `
          SELECT 1
          FROM deliveries
          WHERE delivery_date = $1
            AND delivery_time = $2
            AND COALESCE(status,'') <> 'cancelled'
          LIMIT 1
          `,
          [date, time]
        );
        if (exists.rows.length) throw new Error("Slot is already booked");

        const isWeekend = isWeekendISODate(date);
        const afterHours = window === "after_hours";

        await pool.query(
          `
          INSERT INTO deliveries (
            delivery_date,
            delivery_time,
            status,
            customer_name,
            customer_email,
            customer_phone,
            pickup_address,
            delivery_address,
            distance_miles,
            base_rate,
            per_mile_rate,
            total_cost,
            fragile,
            priority,
            time_sensitive,
            weekend,
            holiday,
            after_hours
          )
          VALUES (
            $1,$2,'scheduled',
            $3,$4,$5,$6,$7,
            0,0,0,0,
            false,false,false,
            $8,false,$9
          )
          `,
          [
            date,
            time,
            "Scheduling Hold",
            "pending@smilesinroute.delivery",
            "0000000000",
            "TBD",
            "TBD",
            isWeekend,
            afterHours,
          ]
        );
      }

      return json(res, 200, { success: true, serviceType, date, time, window });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  /* ---------- DISTANCE ---------- */
  if (pathname === "/api/distance" && method === "POST") {
    try {
      const { pickup, delivery } = await readJson(req);
      const p = asTrimmedString(pickup);
      const d = asTrimmedString(delivery);
      if (!p || !d) throw new Error("pickup and delivery are required");

      const { getDistanceMiles } = require("./src/lib/distanceMatrix");
      const miles = await getDistanceMiles(p, d);

      return json(res, 200, { distance_miles: miles });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  /* ---------- QUOTE ---------- */
  if (pathname === "/api/quote" && method === "POST") {
    try {
      const body = await readJson(req);

      const service_type = asTrimmedString(body.service_type);
      const region = asTrimmedString(body.region);
      const vehicle_type = asTrimmedString(body.vehicle_type);

      const distance_miles = assertFiniteNumber(body.distance_miles ?? 0, "distance_miles");
      const fragile = Boolean(body.fragile);
      const priority = Boolean(body.priority);
      const signatures = assertFiniteNumber(body.signatures ?? 0, "signatures");

      let sql;
      let params;

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
        breakdown.base = Number(p.base_rate || 0);
        breakdown.mileage = Number(p.per_mile_rate || 0) * Number(distance_miles);
        breakdown.fragile = fragile ? Number(p.fragile_fee || 0) : 0;
        breakdown.priority = priority ? Number(p.priority_fee || 0) : 0;
      } else {
        breakdown.base = Number(p.base_rate || 0);
        breakdown.travel = Number(p.notary_travel_fee || 0);
        breakdown.signatures = Number(p.notary_per_signature_fee || 0) * Number(signatures);
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
      return json(res, 400, { error: err.message });
    }
  }

  /* ---------- DISPATCH APPROVE ---------- */
  if (pathname === "/api/dispatch/approve" && method === "POST") {
    const client = await pool.connect();
    try {
      const body = await readJson(req);
      const orderId = asTrimmedString(body.order_id);
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

      // Idempotent: reuse existing Stripe session if already created
      if (order.stripe_session_id && order.stripe_checkout_url) {
        await client.query("COMMIT");

        const emailed = await sendDispatchPaymentEmailSafe({
          to: String(order.customer_email || "").trim(),
          orderId,
          service_type: String(order.service_type || "courier"),
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

      const email = String(order.customer_email || "").trim();
      if (!isValidEmail(email)) throw new Error("Order is missing a valid customer_email");

      const total_amount = assertFiniteNumber(order.total_amount, "total_amount");
      if (total_amount <= 0) throw new Error("Order total_amount must be > 0");

      const stripeKey = asTrimmedString(process.env.STRIPE_SECRET_KEY);
      if (!stripeKey) throw new Error("Missing STRIPE_SECRET_KEY on server");

      const Stripe = require("stripe");
      const stripe = new Stripe(stripeKey);

      const { success_url, cancel_url } = buildRedirectUrls(orderId);

      const pickup_address = String(order.pickup_address || "");
      const delivery_address = String(order.delivery_address || "");
      const service_type = String(order.service_type || "courier");

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_email: email,
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
        to: email,
        orderId,
        service_type,
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
      return json(res, 400, { error: err.message });
    } finally {
      client.release();
    }
  }

  /* ---------- CONFIRM ORDER ---------- */
  if ((pathname === "/api/confirm" || pathname === "/api/orders") && method === "POST") {
    try {
      const body = await readJson(req);

      const pickup_address = asTrimmedString(body.pickup_address);
      const delivery_address = asTrimmedString(body.delivery_address);
      const service_type = asTrimmedString(body.service_type);
      const total_amount = assertFiniteNumber(body.total_amount, "total_amount");

      if (!pickup_address || !delivery_address) throw new Error("pickup_address and delivery_address are required");
      if (!service_type) throw new Error("service_type is required");
      if (total_amount <= 0) throw new Error("total_amount must be > 0");

      const created = await insertOrderSafe(pool, {
        pickup_address,
        delivery_address,
        service_type,
        total_amount,
        status: "confirmed_pending_payment",
        customer_email: asNullableTrimmedString(body.customer_email),
        distance_miles: body.distance_miles ?? null,
        scheduled_date: asNullableTrimmedString(body.scheduled_date),
        scheduled_time: asNullableTrimmedString(body.scheduled_time),
      });

      const emailed_confirmation = await sendConfirmEmailSafe({
        to: body.customer_email,
        orderId: created.id,
        ...body,
      });

      return json(res, 201, { ...created, emailed_confirmation });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  /* ---------- ROOT ---------- */
  if (pathname === "/" && method === "GET") {
    return sendText(res, 200, "Smiles in Route API");
  }

  return json(res, 404, { error: "Not found" });
}

module.exports = { handleAPI };
