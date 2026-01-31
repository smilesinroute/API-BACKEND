"use strict";

const Stripe = require("stripe");

// Initialize Stripe once
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * Create Stripe Checkout Session
 * ==============================
 * - One-time card payment
 * - Order ID stored in metadata for webhook reconciliation
 */
async function createPaymentSession(order) {
  if (!process.env.FRONTEND_URL) {
    throw new Error("FRONTEND_URL is not set");
  }

  if (!order || !order.id || typeof order.total_amount !== "number") {
    throw new Error("Invalid order data");
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
          // Stripe expects cents as an integer
          unit_amount: Math.round(order.total_amount * 100),
        },
        quantity: 1,
      },
    ],

    success_url: `${process.env.FRONTEND_URL}/payment-success`,
    cancel_url: `${process.env.FRONTEND_URL}/payment-cancelled`,

    metadata: {
      order_id: String(order.id),
    },
  });
}

module.exports = {
  createPaymentSession,
};
