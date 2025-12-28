const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

/*
========================================
 STRIPE WEBHOOK HANDLER
========================================
*/
async function handleStripeWebhook(req, res, pool) {
  const sig = req.headers['stripe-signature'];

  let event;

  try {
    // IMPORTANT: must be raw body
    event = stripe.webhooks.constructEvent(
      req.rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[WEBHOOK] Signature verification failed:', err.message);
    res.writeHead(400);
    res.end('Invalid signature');
    return;
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      const orderId = session.metadata?.order_id;
      if (!orderId) {
        throw new Error('Missing order_id in session metadata');
      }

      const { rows } = await pool.query(
        `
        UPDATE orders
        SET status = 'paid'
        WHERE id = $1
        RETURNING *
        `,
        [orderId]
      );

      if (!rows.length) {
        throw new Error('Order not found for webhook');
      }

      console.log('[WEBHOOK] Order marked paid:', orderId);
    }

    res.writeHead(200);
    res.end(JSON.stringify({ received: true }));
  } catch (err) {
    console.error('[WEBHOOK] Processing error:', err.message);
    res.writeHead(500);
    res.end('Webhook processing failed');
  }
}

module.exports = { handleStripeWebhook };
