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
    const notaryLabel = quote.notarialActs ? `Notary fees (${quote.notarialActs} at $10.00 per act)` : "Notary fees";
    const travelLabel = quote.notarialActs ? `Travel fee (${quote.travelMiles} one-way road miles at ${dollars(quote.travelPerMileCents)}/mile, ${dollars(quote.travelMinimumCents)} minimum)` : "Travel fee";
    const time = order.requested_time?.label || String(order.scheduled_time || "").slice(0, 5);
    return withTimeout(sendMail({ to, subject: "Your mobile notary quote and payment link", text: `
Your mobile notary request has been reviewed. Please review these proposed details and fees before paying.

Signing location:
${order.pickup_address}

Requested appointment:
${order.scheduled_date} · ${time} (${TIME_ZONE})

${notaryLabel}: ${dollars(quote.notaryFeeCents)}
${travelLabel}: ${dollars(quote.travelFeeCents)}
Total: ${dollars(quote.notaryFeeCents + quote.travelFeeCents)}

The travel fee is separate from the notarial act fee. Its amount is set by Smiles in Route Transportation LLC and is not determined by Oregon law. Pay only if you agree to the quoted travel fee and total in advance.

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

