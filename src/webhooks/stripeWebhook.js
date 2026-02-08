"use strict";

const Stripe = require("stripe");

// Initialize Stripe once
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * Stripe Webhook Handler
 * ======================================================
 * - Plain Node.js (no Express)
 * - Uses RAW request body (required by Stripe)
 * - Verifies webhook signature
 * - Moves order to ready_for_dispatch on payment
 *
 * Returns:
 *   true  → request handled
 *   false → not a Stripe webhook route
 */
async function handleStripeWebhook(req, res, pool) {
  // Only accept POST
  if (req.method !== "POST") return false;

  // Route must match Stripe dashboard exactly
  if (!req.url.startsWith("/api/webhook/stripe")) {
    return false;
  }

  const signature = req.headers["stripe-signature"];
  if (!signature) {
    res.statusCode = 400;
    res.end("Missing Stripe signature");
    return true;
  }

  /* ======================================================
     READ RAW BODY
  ====================================================== */
  let rawBody = "";
  for await (const chunk of req) {
    rawBody += chunk;
  }

  /* ======================================================
     VERIFY SIGNATURE
  ====================================================== */
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET.trim()
    );
  } catch (err) {
    console.error("[STRIPE] Signature verification failed:", err.message);
    res.statusCode = 400;
    res.end("Invalid signature");
    return true;
  }

  console.log("[STRIPE] Webhook received:", event.type);

  /* ======================================================
     HANDLE EVENTS
  ====================================================== */
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const orderId = session.metadata?.order_id;

    if (!orderId) {
      console.warn(
        "[STRIPE] checkout.session.completed missing order_id metadata"
      );
    } else {
      try {
        await pool.query(
          `
          UPDATE orders
          SET
            payment_status = 'paid',
            status = 'ready_for_dispatch',
            paid_at = NOW()
          WHERE id = $1
          `,
          [orderId]
        );

        console.log(
          "[STRIPE] Order marked as paid and ready for dispatch:",
          orderId
        );
      } catch (err) {
        console.error(
          "[STRIPE] Failed to update order after payment:",
          err
        );
      }
    }
  }

  /* ======================================================
     ACKNOWLEDGE STRIPE
  ====================================================== */
  res.statusCode = 200;
  res.end("ok");
  return true;
}

module.exports = {
  handleStripeWebhook,
};
