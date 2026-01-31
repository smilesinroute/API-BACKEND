"use strict";

const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * Stripe webhook handler
 * - Verifies Stripe signature using raw body
 * - Marks order as paid on checkout.session.completed
 */
async function handleStripeWebhook(req, res, pool) {
  // Only accept POST
  if (req.method !== "POST") return false;

  // ✅ FIXED PATH (must match Stripe dashboard exactly)
  if (!req.url.startsWith("/api/webhook/stripe")) {
    return false;
  }

  const sig = req.headers["stripe-signature"];
  if (!sig) {
    res.statusCode = 400;
    res.end("Missing Stripe signature");
    return true;
  }

  // Read RAW body (required by Stripe)
  let rawBody = "";
  for await (const chunk of req) {
    rawBody += chunk;
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("[STRIPE] Signature verification failed:", err.message);
    res.statusCode = 400;
    res.end("Invalid signature");
    return true;
  }

  console.log("[STRIPE] Webhook received:", event.type);

  // Handle successful checkout
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const orderId = session.metadata?.order_id;

    if (!orderId) {
      console.warn("[STRIPE] checkout.session.completed missing order_id");
    } else {
      await pool.query(
        `
        UPDATE orders
        SET
          payment_status = 'paid',
          paid_at = NOW()
        WHERE id = $1
        `,
        [orderId]
      );

      console.log("[STRIPE] Order marked as paid:", orderId);
    }
  }

  // ✅ Always acknowledge Stripe
  res.statusCode = 200;
  res.end("ok");
  return true;
}

module.exports = { handleStripeWebhook };
