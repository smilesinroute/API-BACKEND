"use strict";

const Stripe = require("stripe");

/**
 * Stripe webhook handler
 *
 * Requirements:
 * - MUST read raw body
 * - MUST verify Stripe signature before parsing JSON
 * - MUST be idempotent (Stripe may retry events)
 *
 * Lifecycle responsibility:
 * approved_pending_payment  →  paid
 */
async function handleStripeWebhook(req, res, pool) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const signature = req.headers["stripe-signature"];

  if (!signature) {
    res.statusCode = 400;
    return res.end("Missing Stripe signature");
  }

  /* ===============================
     READ RAW BODY (NO JSON PARSE)
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
     VERIFY STRIPE SIGNATURE
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
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;

        const orderId = session.metadata?.order_id;
        if (!orderId) {
          console.error("[STRIPE] Missing order_id in session metadata");
          res.statusCode = 400;
          return res.end("Missing order_id metadata");
        }

        /**
         * IMPORTANT:
         * - Stripe may retry webhooks
         * - We only transition if not already paid
         */
        const result = await pool.query(
          `
          UPDATE orders
          SET
            payment_status = 'paid',
            paid_at = NOW(),
            status = 'paid'
          WHERE id = $1
            AND payment_status IS DISTINCT FROM 'paid'
          RETURNING id
          `,
          [orderId]
        );

        if (result.rowCount === 0) {
          console.log(
            `[STRIPE] Order ${orderId} already marked as paid (idempotent skip)`
          );
        } else {
          console.log(`✅ Order ${orderId} transitioned to PAID`);
        }

        break;
      }

      default:
        // We acknowledge all events, even if unused
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
