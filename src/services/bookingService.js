// apps/api/src/services/bookingService.js
const { v4: uuidv4 } = require('uuid');
const stripeService = require('./stripeService');
const { insertBooking } = require('../db/queries');

async function createBookingAndPayment(payload) {
  // payload: { customerInfo, bookingDetails }
  const bookingId = `booking_${Date.now()}_${uuidv4().slice(0, 8)}`;
  const bookingRecord = {
    id: bookingId,
    customer_info: payload.customerInfo,
    service_type: payload.bookingDetails.serviceType,
    from_address: payload.bookingDetails.fromAddress,
    to_address: payload.bookingDetails.toAddress,
    total_price: payload.bookingDetails.totalPrice,
    status: 'pending_payment',
    created_at: new Date().toISOString(),
  };

  // Save booking (DB helper)
  await insertBooking(bookingRecord).catch(err => {
    console.error('DB insert booking error', err);
    throw new Error('Failed saving booking');
  });

  // Create Stripe payment link (or checkout session)
  const payment = await stripeService.createPaymentLink({
    amount: Math.round(bookingRecord.total_price * 100),
    currency: 'usd',
    metadata: {
      bookingId
    },
    description: `${bookingRecord.service_type} - ${bookingRecord.from_address} → ${bookingRecord.to_address}`
  });

  return {
    success: true,
    booking: bookingRecord,
    paymentUrl: payment.url || payment.checkoutUrl || null
  };
}

// Minimal Stripe webhook handler wrapper
async function handleStripeWebhook(req) {
  return stripeService.processWebhook(req);
}

module.exports = {
  createBookingAndPayment,
  handleStripeWebhook
};
