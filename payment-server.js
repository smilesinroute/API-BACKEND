const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Initialize Stripe with secret key
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Payment API is running', timestamp: new Date().toISOString() });
});

// Create Payment Intent
app.post('/api/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency = 'usd', metadata = {} } = req.body;

    // Validate amount
    if (!amount || amount < 50) { // Minimum $0.50
      return res.status(400).json({ 
        error: 'Invalid amount. Minimum charge is $0.50' 
      });
    }

    // Create payment intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount), // Amount in cents
      currency,
      metadata: {
        ...metadata,
        created_at: new Date().toISOString(),
        source: 'smiles-in-route-portal'
      },
      automatic_payment_methods: {
        enabled: true,
      },
    });

    // Log the payment intent creation
    if (metadata.orderId) {
      await supabase
        .from('payment_logs')
        .insert({
          order_id: metadata.orderId,
          payment_intent_id: paymentIntent.id,
          amount: amount,
          currency,
          status: 'created',
          metadata,
          created_at: new Date().toISOString()
        });
    }

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id
    });

  } catch (error) {
    console.error('Error creating payment intent:', error);
    res.status(500).json({ 
      error: 'Failed to create payment intent',
      details: error.message 
    });
  }
});

// Confirm Payment
app.post('/api/confirm-payment', async (req, res) => {
  try {
    const { paymentIntentId, orderId } = req.body;

    // Retrieve payment intent from Stripe
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status === 'succeeded') {
      // Update order status in database
      if (orderId) {
        await supabase
          .from('orders')
          .update({ 
            payment_status: 'paid',
            payment_intent_id: paymentIntentId,
            paid_at: new Date().toISOString(),
            status: 'confirmed'
          })
          .eq('id', orderId);

        // Log successful payment
        await supabase
          .from('payment_logs')
          .update({ 
            status: 'succeeded',
            confirmed_at: new Date().toISOString()
          })
          .eq('payment_intent_id', paymentIntentId);
      }

      res.json({
        success: true,
        paymentIntent: {
          id: paymentIntent.id,
          status: paymentIntent.status,
          amount: paymentIntent.amount,
          currency: paymentIntent.currency
        }
      });
    } else {
      res.status(400).json({
        success: false,
        error: 'Payment not completed',
        status: paymentIntent.status
      });
    }

  } catch (error) {
    console.error('Error confirming payment:', error);
    res.status(500).json({ 
      error: 'Failed to confirm payment',
      details: error.message 
    });
  }
});

// Handle Stripe Webhooks
app.post('/api/stripe-webhook', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  switch (event.type) {
    case 'payment_intent.succeeded':
      const paymentIntent = event.data.object;
      console.log('Payment succeeded:', paymentIntent.id);
      
      // Update database
      if (paymentIntent.metadata.orderId) {
        await supabase
          .from('orders')
          .update({ 
            payment_status: 'paid',
            status: 'confirmed',
            paid_at: new Date().toISOString()
          })
          .eq('id', paymentIntent.metadata.orderId);
      }
      break;

    case 'payment_intent.payment_failed':
      const failedPayment = event.data.object;
      console.log('Payment failed:', failedPayment.id);
      
      // Update database
      if (failedPayment.metadata.orderId) {
        await supabase
          .from('payment_logs')
          .update({ 
            status: 'failed',
            failed_at: new Date().toISOString(),
            failure_reason: failedPayment.last_payment_error?.message
          })
          .eq('payment_intent_id', failedPayment.id);
      }
      break;

    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  res.json({received: true});
});

// Get Payment Status
app.get('/api/payment-status/:paymentIntentId', async (req, res) => {
  try {
    const { paymentIntentId } = req.params;
    
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    
    res.json({
      id: paymentIntent.id,
      status: paymentIntent.status,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      created: paymentIntent.created,
      metadata: paymentIntent.metadata
    });

  } catch (error) {
    console.error('Error retrieving payment status:', error);
    res.status(500).json({ 
      error: 'Failed to retrieve payment status',
      details: error.message 
    });
  }
});

// Refund Payment
app.post('/api/refund-payment', async (req, res) => {
  try {
    const { paymentIntentId, amount, reason = 'requested_by_customer' } = req.body;

    const refund = await stripe.refunds.create({
      payment_intent: paymentIntentId,
      amount, // Optional: partial refund
      reason
    });

    // Update database
    await supabase
      .from('payment_logs')
      .insert({
        payment_intent_id: paymentIntentId,
        refund_id: refund.id,
        amount: refund.amount,
        status: 'refunded',
        reason,
        created_at: new Date().toISOString()
      });

    res.json({
      success: true,
      refund: {
        id: refund.id,
        amount: refund.amount,
        status: refund.status
      }
    });

  } catch (error) {
    console.error('Error processing refund:', error);
    res.status(500).json({ 
      error: 'Failed to process refund',
      details: error.message 
    });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`💳 Payment API server running on port ${PORT}`);
  console.log(`🔗 API endpoints available at http://localhost:${PORT}/api/*`);
});

module.exports = app;
