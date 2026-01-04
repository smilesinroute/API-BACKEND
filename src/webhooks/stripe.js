"use strict";

const Stripe = require("stripe");

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handleStripeWebhook(req, res, pool) {
  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripeSecret || !webhookSecret) {
    console.error("[STRIPE] Missing secrets");
    res.writeHead(500);
    return res.end("Stripe not configured");
  }

  const stripe = new Stripe(stripeSecret, { apiVersion: "2024-06-20" });

  let event;
  try {
    const rawBody = await readRawBody(req);
    const sig = req.headers["stripe-signature"];

    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      webhookSecret
    );
  } catch (err) {
    console.error("[STRIPE] Signature failed:", err.message);
    res.writeHead(400);
    return res.end("Invalid signature");
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const orderId = session.metadata?.order_id;

      if (!orderId) throw new Error("Missing order_id");

      await pool.query(
        `
        UPDATE orders
        SET
          payment_status = 'paid',
          paid_at = NOW(),
          status = 'ready_for_dispatch'
        WHERE id = $1
          AND payment_status <> 'paid'
        `,
        [orderId]
      );

      console.log("[STRIPE] Order paid:", orderId);
    }

    res.writeHead(200);
    res.end("ok");
  } catch (err) {
    console.error("[STRIPE] Handler error:", err.message);
    res.writeHead(500);
    res.end("Webhook error");
  }
}

module.exports = { handleStripeWebhook };
