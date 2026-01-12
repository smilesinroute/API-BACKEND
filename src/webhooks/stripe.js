"use strict";

const Stripe = require("stripe");

/**
 * Stripe webhook handler
 * - MUST read raw body
 * - MUST verify signature BEFORE parsing JSON
 */
async function handleStripeWebhook(req, res, pool) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers["stripe-signature"];

  if (!sig) {
    res.statusCode = 400;
    return res.end("Missing Stripe signature");
  }

  let rawBody;

  try {
    rawBody = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  } catch (err) {
    res.statusCode = 400;
    return res.end("Failed to read request body");
  }

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("[STRIPE] Signature failed:", err.message);
    res.statusCode = 400;
    return res.end(`Webhook Error: ${err.message}`);
  }

  /* ============================================
     HANDLE EVENTS
  ============================================ */

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const orderId = session.metadata?.order_id;

    if (!orderId) {
      res.statusCode = 400;
      return res.end("Missing order_id metadata");
    }

    await pool.query(
      `
      UPDATE orders
      SET
        payment_status = 'paid',
        paid_at = NOW(),
        status = 'ready_for_dispatch'
      WHERE id = $1
      `,
      [orderId]
    );

    console.log(`✅ Order ${orderId} marked as PAID`);
  }

  res.statusCode = 200;
  res.end("ok");
}

module.exports = { handleStripeWebhook };
