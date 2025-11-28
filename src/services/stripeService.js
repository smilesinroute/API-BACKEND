// apps/api/src/services/stripeService.js
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2022-11-15' });

// Create a simple payment link (Stripe Payment Links)
async function createPaymentLink({ amount, currency = 'usd', metadata = {}, description = '' }) {
  if (!process.env.STRIPE_SECRET_KEY) {
    return { url: `${process.env.FRONTEND_URL || ''}/pay?amount=${amount}` }; // dev fallback
  }

  const product = await stripe.products.create({ name: description.substring(0, 120) });
  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: amount,
    currency
  });

  const paymentLink = await stripe.paymentLinks.create({
    line_items: [{ price: price.id, quantity: 1 }],
    metadata
  });

  return { url: paymentLink.url };
}

async function processWebhook(req) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.warn('Stripe webhook secret not set; skipping verification');
    // Optionally parse body
    return { success: true };
  }

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (e) {
    throw new Error('Invalid stripe signature');
  }

  // handle relevant events
  if (event.type === 'payment_intent.succeeded' || event.type === 'checkout.session.completed') {
    // implement business logic: update booking status, notify emails, etc.
    console.log('Stripe payment event', event.type);
  }

  return { received: true };
}

module.exports = {
  createPaymentLink,
  processWebhook
};
