"use strict";

const Stripe = require("stripe");

// Initialize Stripe once
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * Stripe webhook handler
 * ======================
 * - Manual router compatible (non-Express)
 * - Uses RAW request body (required by Stripe)
 * - Trims webhook secret to handle Render newline injection
 * - Marks order as paid on checkout.session.completed
 *
 * Returns:
 *   true  → request handled
 *   false → not a Stripe webhook route
 */
async function handleStripeWebhook(req, res, pool) {
  // Only accept POST requests
  if (req.method !== "POST") return false;

  // Path MUST match Stripe dashboard exactly
  if (!req.url.startsWith("/api/webhook/stripe")) {
    return false;
  }

  // Stripe signature header
  const signature = req.headers["stripe-signature"];
  if (!signature) {
    res.statusCode = 400;
    res.end("Missing Stripe signature");
    return true;
  }

  // Read RAW body (no parsing, no mutation)
  let rawBody = "";
  for await (const chunk of req) {
    rawBody += chunk;
  }

  // Verify webhook signature
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET.trim() // 🔑 CRITICAL FIX
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
      console.warn("[STRIPE] checkout.session.completed missing order_id metadata");
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

  // Always acknowledge Stripe
  res.statusCode = 200;
  res.end("ok");
  return true;
}

module.exports = {
  handleStripeWebhook,
};
