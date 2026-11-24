"use strict";

const { randomUUID } = require("node:crypto");
const reviewStatuses = ["pending", "pending_admin_review", "confirmed_pending_payment"];

function fail(statusCode, message) {
  throw Object.assign(new Error(message), { statusCode });
}

function ensureReviewable(order) {
  if (order.service_type !== "courier") fail(400, "Choose a courier order.");
  if (!reviewStatuses.includes(order.status) || ![null, undefined, "unpaid"].includes(order.payment_status) ||
      order.paid_at || order.assigned_driver_id || order.stripe_session_id) {
    fail(409, "This order has moved forward. Refresh before reviewing it.");
  }
}

async function locked(pool, id, action) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [order] } = await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [id]);
    if (!order || (order.company_id != null && order.company_id !== 1)) fail(404, "Order not found.");
    const result = await action(client, order);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function checkRevision(order, expected) {
  if (expected !== (order.pricing_breakdown?.quoteRevision ?? null)) {
    fail(409, "This quote changed. Refresh and review the current price before continuing.");
  }
}

async function saveCourierQuote(pool, id, body) {
  const price = body.total_amount;
  if (typeof price !== "string" || !/^(0|[1-9]\d{0,4})(\.\d{1,2})?$/.test(price.trim()) || Number(price) <= 0) {
    fail(400, "Enter a positive courier price in dollars and cents.");
  }
  return locked(pool, id, async (client, order) => {
    ensureReviewable(order);
    checkRevision(order, body.expected_quote_revision);
    if (Number(order.total_amount) > 0) fail(409, "This order already has a quoted price. Refresh to review it.");
    const pricing = { ...order.pricing_breakdown, quoteRevision: randomUUID(), dispatchQuotedTotalCents: Math.round(Number(price) * 100) };
    const { rows: [saved] } = await client.query(
      "UPDATE orders SET total_amount = $2, pricing_breakdown = $3 WHERE id = $1 RETURNING *",
      [id, price.trim(), JSON.stringify(pricing)]
    );
    return saved;
  });
}

async function approveCourierOrder(pool, id, body, createSession) {
  return locked(pool, id, async (client, order) => {
    if (order.service_type === "courier" && order.status === "approved_pending_payment" &&
        order.stripe_session_id && order.stripe_checkout_url && order.payment_status !== "paid") {
      return { order, session: { id: order.stripe_session_id, url: order.stripe_checkout_url }, reused: true };
    }
    ensureReviewable(order);
    checkRevision(order, body.expected_quote_revision ?? null);
    if (!Number.isFinite(Number(order.total_amount)) || Number(order.total_amount) <= 0) {
      fail(400, "Save the courier price before approving this request.");
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(order.customer_email || "")) {
      fail(400, "A valid customer email is needed before sending a payment link.");
    }
    let session;
    try { session = await createSession(order); }
    catch { fail(502, "Could not create the payment link. Try approving this request again."); }
    if (!session?.id || !session.url?.startsWith("https://")) fail(502, "Could not create a payment link.");
    const { rows: [saved] } = await client.query(
      "UPDATE orders SET status = 'approved_pending_payment', stripe_session_id = $2, stripe_checkout_url = $3 WHERE id = $1 RETURNING *",
      [id, session.id, session.url]
    );
    return { order: saved, session, reused: false };
  });
}

module.exports = { saveCourierQuote, approveCourierOrder };
