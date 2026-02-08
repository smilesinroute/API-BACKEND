"use strict";

const Stripe = require("stripe");
const { assignDriver } = require("../drivers/driverAssignments");

/**
 * ======================================================
 * STRIPE WEBHOOK HANDLER (Production Safe)
 * ======================================================
 * Responsibilities:
 * - Verify Stripe webhook signature
 * - Mark order as paid (idempotent)
 * - Auto-assign driver if none assigned
 * - Never crash on retries
 */

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/* ======================================================
   MAIN HANDLER
====================================================== */
async function handleStripeWebhook(req, res, pool) {
  if (req.method !== "POST") {
    return false;
  }

  if (!req.url.startsWith("/api/webhook/stripe")) {
    return false;
  }

  const signature = req.headers["stripe-signature"];

  if (!signature) {
    res.statusCode = 400;
    return res.end("Missing Stripe signature");
  }

  /* ===============================
     READ RAW BODY
  =============================== */
  let rawBody;
  try {
    rawBody = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  } catch (err) {
    console.error("[STRIPE] Failed to read raw body:", err);
    res.statusCode = 400;
    return res.end("Invalid request body");
  }

  /* ===============================
     VERIFY SIGNATURE
  =============================== */
  let event;
  try {
    const secret = String(process.env.STRIPE_WEBHOOK_SECRET || "").trim();

    if (!secret) {
      console.error("[STRIPE] Missing webhook secret");
      res.statusCode = 500;
      return res.end("Webhook secret not configured");
    }

    event = stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch (err) {
    console.error("[STRIPE] Signature verification failed:", err.message);
    res.statusCode = 400;
    return res.end(`Webhook Error: ${err.message}`);
  }

  console.log("[STRIPE] Event received:", event.type);

  /* ===============================
     HANDLE EVENTS
  =============================== */
  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const orderId = session.metadata?.order_id;

      if (!orderId) {
        console.error("[STRIPE] Missing order_id in metadata");
        res.statusCode = 400;
        return res.end("Missing order_id metadata");
      }

      /* ---------- Mark order as paid (idempotent) ---------- */
      const paidResult = await pool.query(
        `
        UPDATE orders
        SET
          payment_status = 'paid',
          paid_at = NOW(),
          status = 'paid'
        WHERE id = $1
          AND payment_status IS DISTINCT FROM 'paid'
        RETURNING id, assigned_driver_id
        `,
        [orderId]
      );

      if (paidResult.rowCount === 0) {
        console.log(
          `[STRIPE] Order ${orderId} already marked paid — skipping`
        );
      } else {
        console.log(`✅ Order ${orderId} marked as PAID`);
      }

      /* ---------- Check assignment ---------- */
      const { rows } = await pool.query(
        `
        SELECT assigned_driver_id
        FROM orders
        WHERE id = $1
        `,
        [orderId]
      );

      if (!rows.length) {
        throw new Error("Order not found after payment");
      }

      if (rows[0].assigned_driver_id) {
        console.log(
          `[DISPATCH] Order ${orderId} already has driver — skipping`
        );
      } else {
        /* ---------- Select available driver ---------- */
        const driverResult = await pool.query(
          `
          SELECT id
          FROM drivers
          WHERE active = true
          ORDER BY last_assigned_at NULLS FIRST, created_at ASC
          LIMIT 1
          `
        );

        if (!driverResult.rows.length) {
          console.warn(
            `[DISPATCH] No available drivers for order ${orderId}`
          );
        } else {
          const driverId = driverResult.rows[0].id;

          await assignDriver(pool, orderId, driverId);

          console.log(
            `🚚 Driver ${driverId} assigned to order ${orderId}`
          );
        }
      }
    } else {
      console.log(`[STRIPE] Ignored event: ${event.type}`);
    }
  } catch (err) {
    console.error("[STRIPE] Webhook processing error:", err);
    res.statusCode = 500;
    return res.end("Webhook handler failure");
  }

  /* ===============================
     ACKNOWLEDGE STRIPE
  =============================== */
  res.statusCode = 200;
  res.end("ok");
  return true;
}

module.exports = { handleStripeWebhook };
