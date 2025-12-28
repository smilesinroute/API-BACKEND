const crypto = require('crypto');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { sendPaymentEmail } = require('../email/sendPaymentEmail');

async function handleStripeWebhook(req, res, pool) {
  let body = '';

  req.on('data', chunk => (body += chunk));
  req.on('end', async () => {
    const sig = req.headers['stripe-signature'];

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        body,
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
        if (!orderId) throw new Error('Missing order_id in metadata');

        const { rows } = await pool.query(
          `
          UPDATE orders
          SET status = 'paid'
          WHERE id = $1
          RETURNING *
          `,
          [orderId]
        );

        const order = rows[0];

        // Send confirmation email
        await sendPaymentEmail({
          to: session.customer_details.email,
          customerName: session.customer_details.name || 'Customer',
          serviceType: order.service_type,
          pickup: order.pickup_address,
          delivery: order.delivery_address,
          date: order.scheduled_date,
          time: order.scheduled_time,
          distance: session.metadata.distance,
          total: order.total_amount,
          checkoutUrl: null, // already paid
        });
      }

      res.writeHead(200);
      res.end('Webhook processed');

    } catch (err) {
      console.error('[WEBHOOK] Processing error:', err.message);
      res.writeHead(500);
      res.end('Webhook error');
    }
  });
}

module.exports = { handleStripeWebhook };
