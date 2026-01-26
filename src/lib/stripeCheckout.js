"use strict";

const Stripe = require("stripe");

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("STRIPE_SECRET_KEY is not set");
}

if (!process.env.FRONTEND_URL) {
  throw new Error("FRONTEND_URL is not set");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * Create a Stripe Checkout session for an order
 */
async function createStripeCheckout({ orderId, amount, email }) {
  if (!orderId || !amount || !email) {
    throw new Error("Missing required Stripe checkout parameters");
  }

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    customer_email: email,
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: {
            name: "Smiles in Route – Courier Delivery",
            description: `Order ${orderId}`,
          },
          unit_amount: Math.round(Number(amount) * 100),
        },
        quantity: 1,
      },
    ],
    success_url: `${process.env.FRONTEND_URL}/payment/success?order=${orderId}`,
    cancel_url: `${process.env.FRONTEND_URL}/payment/cancel?order=${orderId}`,
    metadata: {
      order_id: orderId,
    },
  });

  return {
    sessionId: session.id,
    url: session.url,
  };
}

module.exports = {
  createStripeCheckout,
};
