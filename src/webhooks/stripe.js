"use strict";

const Stripe = require("stripe");

/**
 * ======================================================
 * STRIPE WEBHOOK HANDLER (Payment → Dispatch Ready)
 * ======================================================
 * Responsibilities:
 * - Verify Stripe webhook signature
 * - Mark order as paid (idempotent)
 * - Move order into dispatch queue
 * - Never crash on retries
 */

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/* ======================================================
   MAIN HANDLER
====================================================== */
async function handleStripeWebhook(req, res, pool) {
  if (req.method !== "POST") return false;
  if (!req.url.startsWith("/api/webhook/stripe")) return false;

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
      const result = await pool.query(
        `
        UPDATE orders
        SET
          payment_status = 'paid',
          paid_at = NOW(),
          status = 'ready_for_dispatch'
        WHERE id = $1
          AND payment_status IS DISTINCT FROM 'paid'
        RETURNING id
        `,
        [orderId]
      );

      if (result.rowCount === 0) {
        console.log(`[STRIPE] Order ${orderId} already marked paid`);
      } else {
        console.log(
          `✅ Order ${orderId} marked as PAID → ready_for_dispatch`
        );
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

