
"use strict";

const Stripe = require("stripe");

/**
 * ======================================================
 * STRIPE CHECKOUT SESSION CREATOR
 * ======================================================
 * Responsibilities:
 * - Create a Stripe Checkout session for an order
 * - Store order_id in Stripe metadata
 * - Redirect customer to public success/cancel pages
 * - Validate inputs and environment configuration
 */

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/* ======================================================
   CREATE PAYMENT SESSION
====================================================== */
async function createPaymentSession(order) {
  /* ---------- Validate order ---------- */
  if (!order || !order.id) {
    throw new Error("Invalid order provided to Stripe checkout");
  }

  const amountCents = Math.round(Number(order.total_amount) * 100);

  if (!amountCents || amountCents <= 0) {
    throw new Error(
      `Invalid order amount for order ${order.id}`
    );
  }

  /* ---------- Validate redirect URLs ---------- */
  const successUrl = process.env.STRIPE_SUCCESS_URL;
  const cancelUrl = process.env.STRIPE_CANCEL_URL;

  if (!successUrl || !cancelUrl) {
    throw new Error(
      "Missing STRIPE_SUCCESS_URL or STRIPE_CANCEL_URL in environment"
    );
  }

  let lineItems = [{ price_data: { currency: "usd", product_data: {
    name: `Courier Service – Order ${order.id.slice(0, 8)}`,
  }, unit_amount: amountCents }, quantity: 1 }];
  let options;
  if (order.service_type === "notary") {
    const quote = require("./notaryQuote").savedQuote(order);
    lineItems = [
      ["Mobile notary fees", quote.notaryFeeCents],
      ["Notary travel fee", quote.travelFeeCents],
    ].filter(([, cents]) => cents > 0).map(([name, cents]) => ({
      price_data: { currency: "usd", product_data: { name }, unit_amount: cents }, quantity: 1,
    }));
    options = { idempotencyKey: `notary:${order.id}:${quote.quoteRevision}`, timeout: 15000, maxNetworkRetries: 0 };
  }

  /* ---------- Create checkout session ---------- */
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],

    customer_email: order.customer_email || undefined,

    line_items: lineItems,

    /* Critical for webhook reconciliation */
    metadata: {
      order_id: order.id,
    },

    success_url: successUrl,
    cancel_url: cancelUrl,
  }, options);

  console.log(
    `[STRIPE] Checkout session created for order ${order.id}`
  );

  return session;
}

module.exports = {
  createPaymentSession,
};
