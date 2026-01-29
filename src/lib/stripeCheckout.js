"use strict";

const Stripe = require("stripe");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

async function createPaymentSession(order) {
  if (!process.env.FRONTEND_URL) {
    throw new Error("FRONTEND_URL is not set");
  }

  return stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: {
            name: `Order ${order.id}`,
          },
          unit_amount: Math.round(order.total_amount * 100),
        },
        quantity: 1,
      },
    ],
    success_url: `${process.env.FRONTEND_URL}/payment-success`,
    cancel_url: `${process.env.FRONTEND_URL}/payment-cancelled`,
    metadata: {
      order_id: order.id,
    },
  });
}

module.exports = { createPaymentSession };
