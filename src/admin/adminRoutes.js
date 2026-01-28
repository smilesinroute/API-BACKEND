"use strict";

const { requireAdmin } = require("./adminAuth");
const { sendCustomerPaymentLink } = require("../lib/dispatchEmails");
const { createPaymentSession } = require("../lib/stripeCheckout");

/**
 * ADMIN ROUTES
 * =============
 * Dispatch / Admin control surface
 *
 * Order lifecycle (authoritative):
 * confirmed_pending_payment  → admin approval required
 * approved_pending_payment   → awaiting customer payment
 * paid                       → payment confirmed
 * in_progress                → driver assigned
 * completed                  → finished
 * rejected                   → admin rejected
 */

async function handleAdminRoutes(req, res, pool, pathname, method, json) {

  /* ======================================================
     DASHBOARD
     GET /admin/dashboard
     → Authoritative dispatch snapshot
  ====================================================== */
  if (pathname === "/admin/dashboard" && method === "GET") {
    requireAdmin(req);

    /* ---------- Load active (non-final) orders ---------- */
    const { rows: orders } = await pool.query(`
      SELECT
        id,
        status,
        pickup_address,
        delivery_address,
        scheduled_date,
        scheduled_time,
        total_amount,
        created_at
      FROM orders
      WHERE status NOT IN ('completed', 'rejected')
      ORDER BY created_at ASC
    `);

    /* ---------- Group orders into lifecycle lanes ---------- */
    const lanes = {
      action_required: [],
      awaiting_payment: [],
      active: [],
    };

    for (const order of orders) {
      switch (order.status) {
        case "confirmed_pending_payment":
          lanes.action_required.push(order);
          break;

        case "approved_pending_payment":
          lanes.awaiting_payment.push(order);
          break;

        case "paid":
        case "in_progress":
          lanes.active.push(order);
          break;
      }
    }

    /* ---------- Supporting stats ---------- */
    const [driversRes, revenueRes] = await Promise.all([
      pool.query(`
        SELECT COUNT(*)::int AS count
        FROM drivers
      `),
      pool.query(`
        SELECT COALESCE(SUM(total_amount), 0)::numeric AS total
        FROM orders
        WHERE status = 'paid'
          AND paid_at IS NOT NULL
          AND paid_at::date = CURRENT_DATE
      `),
    ]);

    json(res, 200, {
      stats: {
        awaitingApproval: lanes.action_required.length,
        awaitingPayment: lanes.awaiting_payment.length,
        activeOrders: lanes.active.length,
        totalDrivers: driversRes.rows[0].count,
        revenueToday: Number(revenueRes.rows[0].total),
      },
      lanes,
      meta: {
        system: "live",
        checkedAt: new Date().toISOString(),
      },
    });

    return true;
  }

  /* ======================================================
     LIST ORDERS
     GET /admin/orders
     → Full order history (admin tools / ops)
  ====================================================== */
  if (pathname === "/admin/orders" && method === "GET") {
    requireAdmin(req);

    const { rows } = await pool.query(`
      SELECT *
      FROM orders
      ORDER BY created_at DESC
    `);

    json(res, 200, { orders: rows });
    return true;
  }

  /* ======================================================
     APPROVE ORDER
     POST /admin/orders/:id/approve
     → Create Stripe Checkout
     → Email customer payment link
  ====================================================== */
  if (
    pathname.startsWith("/admin/orders/") &&
    pathname.endsWith("/approve") &&
    method === "POST"
  ) {
    requireAdmin(req);

    const orderId = pathname.split("/")[3];

    /* ---------- Load order ---------- */
    const { rows } = await pool.query(
      `SELECT * FROM orders WHERE id = $1`,
      [orderId]
    );

    const order = rows[0];

    if (!order) {
      json(res, 404, { error: "Order not found" });
      return true;
    }

    if (!order.customer_email) {
      json(res, 400, { error: "Order missing customer email" });
      return true;
    }

    if (order.status !== "confirmed_pending_payment") {
      json(res, 400, { error: "Order is not in approvable state" });
      return true;
    }

    /* ---------- Create Stripe Checkout ---------- */
    const session = await createPaymentSession(order);

    /* ---------- Persist Stripe metadata ---------- */
    await pool.query(
      `
      UPDATE orders
      SET
        status = 'approved_pending_payment',
        stripe_session_id = $2,
        stripe_checkout_url = $3
      WHERE id = $1
      `,
      [order.id, session.id, session.url]
    );

    /* ---------- Email customer ---------- */
    await sendCustomerPaymentLink({
      to: order.customer_email,
      paymentLink: session.url,
      order,
    });

    json(res, 200, {
      success: true,
      message: "Payment link sent to customer",
      orderId: order.id,
    });

    return true;
  }

  /* ======================================================
     REJECT ORDER
     POST /admin/orders/:id/reject
  ====================================================== */
  if (
    pathname.startsWith("/admin/orders/") &&
    pathname.endsWith("/reject") &&
    method === "POST"
  ) {
    requireAdmin(req);

    const orderId = pathname.split("/")[3];

    await pool.query(
      `
      UPDATE orders
      SET status = 'rejected'
      WHERE id = $1
      `,
      [orderId]
    );

    json(res, 200, { success: true });
    return true;
  }

  return false;
}

module.exports = { handleAdminRoutes };
