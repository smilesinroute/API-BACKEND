"use strict";

const { sendMail } = require("./mailer");
const { WINDOWS, TIME_ZONE } = require("./courierSchedule");

function pickupLabel(order) {
  const window = order.requested_window || WINDOWS.find(slot => slot.value === String(order.scheduled_time || "").slice(0, 5));
  return `${order.scheduled_date} · ${window?.label || order.scheduled_time} (${TIME_ZONE})`;
}

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

Requested pickup window:
${pickupLabel(order)}

Total:
$${Number(order.total_amount).toFixed(2)}

Details for dispatch review:
${order.notes || "No additional arrival instructions."}

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
  if (order.service_type === "notary") {
    const quote = require("./notaryQuote").savedQuote(order);
    const dollars = cents => `$${(cents / 100).toFixed(2)}`;
    const time = order.requested_time?.label || String(order.scheduled_time || "").slice(0, 5);
    return withTimeout(sendMail({ to, subject: "Your mobile notary quote and payment link", text: `
Your mobile notary request has been reviewed. Please review these proposed details and fees before paying.

Signing location:
${order.pickup_address}

Requested appointment:
${order.scheduled_date} · ${time} (${TIME_ZONE})

Notary fees: ${dollars(quote.notaryFeeCents)}
Travel fee: ${dollars(quote.travelFeeCents)}
Total: ${dollars(quote.notaryFeeCents + quote.travelFeeCents)}

If you accept this quote, complete payment at:
${paymentLink}

For changes or questions, call (971) 236-4669 before paying. Dispatch will finalize appointment arrangements after payment.

Request reference: ${order.id}
    `.trim() }), 5_000, "Notary quote email");
  }
  const mailPromise = sendMail({
    to,
    subject: "Your Courier Delivery – Payment Required",
    text: `
Your courier request has been approved.

Pickup:
${order.pickup_address}

Delivery:
${order.delivery_address}

Approved pickup window:
${pickupLabel(order)}

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
  sendNotaryDispatchNotification,
};

async function sendNotaryDispatchNotification(order) {
  if (!process.env.DISPATCH_EMAIL) throw new Error("Missing DISPATCH_EMAIL env variable");
  return withTimeout(sendMail({
    to: process.env.DISPATCH_EMAIL,
    subject: `New mobile notary request #${order.id}`,
    text: `A mobile notary appointment and quote have been requested.\n\nAppointment address:\n${order.pickup_address}\n\n${order.notes}\n\nRequest reference: ${order.id}\n\nNo payment has been collected and no appointment is confirmed.`,
  }), 5_000, "Notary dispatch email");
}

