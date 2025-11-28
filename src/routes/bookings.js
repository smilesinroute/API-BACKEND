// apps/api/src/routes/bookings.js
const express = require('express');
const router = express.Router();

const bookingService = require('../services/bookingService');
const emailService = require('../services/emailService');

// POST /api/bookings/confirm
router.post('/confirm', async (req, res, next) => {
  try {
    const payload = req.body;
    const result = await bookingService.createBookingAndPayment(payload);
    // send email via service (non-blocking)
    emailService.sendBookingRequestEmail(result.booking, payload.customerInfo).catch(console.error);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Webhook endpoint for Stripe (raw body required in production)
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  // bookingService handles signature verification if configured
  try {
    await bookingService.handleStripeWebhook(req);
    res.status(200).send('ok');
  } catch (err) {
    console.error('Webhook error', err);
    res.status(400).send(`Webhook error: ${err.message}`);
  }
});

module.exports = router;
