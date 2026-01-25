"use strict";

const { sendMail } = require("./mailer");

/**
 * Notify dispatch that a new courier order needs review
 */
async function sendDispatchNotification(order) {
  const {
    id,
    pickup_address,
    delivery_address,
    scheduled_date,
    scheduled_time,
    total_amount,
  } = order;

  if (!process.env.DISPATCH_EMAIL) {
    throw new Error("Missing DISPATCH_EMAIL env variable");
  }

  return sendMail({
    to: process.env.DISPATCH_EMAIL,
    subject: `🚚 New Courier Request #${id}`,
    text: `
A new courier request has been submitted and requires dispatch review.

Pickup:
${pickup_address}

Delivery:
${delivery_address}

Scheduled:
${scheduled_date} at ${scheduled_time}

Total:
$${Number(total_amount).toFixed(2)}

Order ID:
${id}
    `.trim(),
  });
}

/**
 * Send customer a payment link after dispatch approval
 */
async function sendCustomerPaymentLink({ to, paymentLink, order }) {
  return sendMail({
    to,
    subject: "Your Courier Delivery – Payment Required",
    text: `
Your courier request has been approved.

Pickup:
${order.pickup_address}

Delivery:
${order.delivery_address}

Scheduled:
${order.scheduled_date} at ${order.scheduled_time}

Total:
$${Number(order.total_amount).toFixed(2)}

Please complete payment here:
${paymentLink}

Once payment is received, dispatch will assign your driver.
    `.trim(),
  });
}

module.exports = {
  sendDispatchNotification,
  sendCustomerPaymentLink,
};
