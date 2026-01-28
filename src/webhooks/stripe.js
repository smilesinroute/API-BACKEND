"use strict";

const Stripe = require("stripe");
const { assignDriver } = require("../drivers/driverAssignments");

/**
 * Stripe webhook handler
 *
 * Responsibilities:
 * - Verify Stripe signature
 * - Mark order as paid (idempotent)
 * - Automatically assign driver (reusing existing logic)
 */
async function handleStripeWebhook(req, res, pool) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
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
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("[STRIPE] Signature verification failed:", err.message);
    res.statusCode = 400;
    return res.end(`Webhook Error: ${err.message}`);
  }

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

      /* ---------- Mark paid (idempotent) ---------- */
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
          `[STRIPE] Order ${orderId} already paid — skipping payment transition`
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
          `[DISPATCH] Order ${orderId} already has driver — skipping assignment`
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
            `🚚 Driver ${driverId} automatically assigned to order ${orderId}`
          );
        }
      }
    } else {
      console.log(`[STRIPE] Ignored event type: ${event.type}`);
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
}

module.exports = { handleStripeWebhook };
