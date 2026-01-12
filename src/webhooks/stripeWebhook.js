"use strict";

const crypto = require("crypto");
const Stripe = require("stripe");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * Stripe webhook handler
 * - Verifies signature
 * - Marks order as paid
 */
async function handleStripeWebhook(req, res, pool) {
  if (req.method !== "POST") return false;

  if (!req.url.startsWith("/api/webhooks/stripe")) {
    return false;
  }

  const sig = req.headers["stripe-signature"];
  if (!sig) {
    res.statusCode = 400;
    res.end("Missing Stripe signature");
    return true;
  }

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

  // ✅ Only care about successful checkout
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    const orderId = session.metadata?.order_id;
    if (!orderId) {
      console.warn("[STRIPE] Missing order_id metadata");
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

      console.log("[STRIPE] Order marked paid:", orderId);
    }
  }

  res.statusCode = 200;
  res.end("ok");
  return true;
}

module.exports = { handleStripeWebhook };
