
"use strict";

const Stripe = require("stripe");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * Create Stripe Checkout session
 * --------------------------------
 * - Used by admin approve flow
 * - Stores order_id in metadata
 * - Redirects to PUBLIC customer site (not admin)
 */
async function createPaymentSession(order) {
  if (!order || !order.id) {
    throw new Error("Invalid order provided to Stripe checkout");
  }

  const amount = Math.round(Number(order.total_amount) * 100);

  if (!amount || amount <= 0) {
    throw new Error("Invalid order amount");
  }

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],

    customer_email: order.customer_email || undefined,

    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: {
            name: `Courier Service – Order ${order.id.slice(0, 8)}`,
          },
          unit_amount: amount,
        },
        quantity: 1,
      },
    ],

    metadata: {
      order_id: order.id,
    },

    success_url:
      "https://smilesinroute.delivery/payment-success",
    cancel_url:
      "https://smilesinroute.delivery/payment-cancelled",
  });

  return session;
}

module.exports = {
  createPaymentSession,
};
