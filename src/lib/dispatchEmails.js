"use strict";

const { sendMail } = require("./mailer");

/* ======================================================
   INTERNAL TIMEOUT WRAPPER
====================================================== */

function withTimeout(promise, ms, label = "operation") {
  let timeoutId;

  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timeoutId);
  });
}

/* ======================================================
   DISPATCH NOTIFICATION
====================================================== */

async function sendDispatchNotification(order) {
  if (!process.env.DISPATCH_EMAIL) {
    throw new Error("Missing DISPATCH_EMAIL env variable");
  }

  const mailPromise = sendMail({
    to: process.env.DISPATCH_EMAIL,
    subject: `🚚 New Courier Request #${order.id}`,
    text: `
A new courier request has been submitted and requires dispatch review.

Pickup:
${order.pickup_address}

Delivery:
${order.delivery_address}

Scheduled:
${order.scheduled_date} at ${order.scheduled_time}

Total:
$${Number(order.total_amount).toFixed(2)}

Order ID:
${order.id}
    `.trim(),
  });

  return withTimeout(mailPromise, 5_000, "Dispatch email");
}

/* ======================================================
   CUSTOMER PAYMENT LINK
====================================================== */

async function sendCustomerPaymentLink({ to, paymentLink, order }) {
  const mailPromise = sendMail({
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

  return withTimeout(mailPromise, 5_000, "Customer payment email");
}

module.exports = {
  sendDispatchNotification,
  sendCustomerPaymentLink,
};
