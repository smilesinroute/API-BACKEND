"use strict";

const { requireAdmin } = require("./adminAuth");
const { sendCustomerPaymentLink } = require("../lib/dispatchEmails");
const { createPaymentSession } = require("../lib/stripeCheckout");

/**
 * ADMIN ROUTES
 * ============
 * Dispatch / Admin control surface
 */

async function handleAdminRoutes(req, res, pool, pathname, method, json) {
  /* ======================================================
     DASHBOARD SUMMARY
     GET /admin/dashboard
  ====================================================== */
  if (pathname === "/admin/dashboard" && method === "GET") {
    requireAdmin(req);

    const [
      pendingRes,
      transitRes,
      driversRes,
      revenueRes,
    ] = await Promise.all([
      pool.query(`
        SELECT COUNT(*)::int AS count
        FROM orders
        WHERE status = 'confirmed_pending_payment'
      `),
      pool.query(`
        SELECT COUNT(*)::int AS count
        FROM orders
        WHERE status = 'in_progress'
      `),
      pool.query(`
        SELECT COUNT(*)::int AS count
        FROM drivers
      `),
      pool.query(`
        SELECT COALESCE(SUM(total_amount), 0)::numeric AS total
        FROM orders
        WHERE created_at::date = CURRENT_DATE
      `),
    ]);

    json(res, 200, {
      pendingOrders: pendingRes.rows[0].count,
      inTransit: transitRes.rows[0].count,
      activeDrivers: driversRes.rows[0].count,
      revenueToday: Number(revenueRes.rows[0].total),
    });

    return true;
  }

  /* ======================================================
     LIST ORDERS
     GET /admin/orders
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
     → CREATE STRIPE CHECKOUT
     → EMAIL CUSTOMER
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

    /* ---------- Persist Stripe info ---------- */
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
