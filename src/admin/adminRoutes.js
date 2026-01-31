"use strict";

const { requireAdmin } = require("./adminAuth");
const { sendCustomerPaymentLink } = require("../lib/dispatchEmails");
const { createPaymentSession } = require("../lib/stripeCheckout");

async function handleAdminRoutes(req, res, pool, pathname, method, json) {
  try {
    /* ======================================================
       DASHBOARD SNAPSHOT
       GET /admin/dashboard
    ====================================================== */
    if (pathname === "/admin/dashboard" && method === "GET") {
      if (!requireAdmin(req, res, json)) return true;

      const { rows: orders } = await pool.query(`
        SELECT
          id,
          status,
          pickup_address,
          delivery_address,
          scheduled_date,
          scheduled_time,
          total_amount,
          customer_email,
          created_at
        FROM orders
        WHERE status NOT IN ('completed', 'rejected')
        ORDER BY created_at ASC
      `);

      const lanes = {
        action_required: [],
        awaiting_payment: [],
        active: [],
      };

      for (const order of orders) {
        if (order.status === "confirmed_pending_payment") {
          lanes.action_required.push(order);
        } else if (order.status === "approved_pending_payment") {
          lanes.awaiting_payment.push(order);
        } else if (
          order.status === "paid" ||
          order.status === "assigned" ||
          order.status === "in_progress"
        ) {
          lanes.active.push(order);
        }
      }

      const [driversRes, revenueRes] = await Promise.all([
        pool.query(`SELECT COUNT(*)::int AS count FROM drivers`),
        pool.query(`
          SELECT COALESCE(SUM(total_amount), 0)::numeric AS total
          FROM orders
          WHERE payment_status = 'paid'
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
       LIST ALL ORDERS
       GET /admin/orders
    ====================================================== */
    if (pathname === "/admin/orders" && method === "GET") {
      if (!requireAdmin(req, res, json)) return true;

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
    ====================================================== */
    if (
      pathname.startsWith("/admin/orders/") &&
      pathname.endsWith("/approve") &&
      method === "POST"
    ) {
      if (!requireAdmin(req, res, json)) return true;

      const orderId = pathname.split("/")[3];

      const { rows } = await pool.query(
        `SELECT * FROM orders WHERE id = $1`,
        [orderId]
      );

      const order = rows[0];
      if (!order) {
        json(res, 404, { error: "Order not found" });
        return true;
      }

      if (order.status !== "confirmed_pending_payment") {
        json(res, 400, { error: "Order is not in approvable state" });
        return true;
      }

      if (!order.customer_email) {
        json(res, 400, { error: "Customer email missing" });
        return true;
      }

      const session = await createPaymentSession(order);

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

      sendCustomerPaymentLink({
        to: order.customer_email,
        paymentLink: session.url,
        order,
      }).catch(err => {
        console.error("[EMAIL] Payment link failed", {
          orderId: order.id,
          error: err.message,
        });
      });

      json(res, 200, {
        success: true,
        message: "Order approved and payment link generated",
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
      if (!requireAdmin(req, res, json)) return true;

      const orderId = pathname.split("/")[3];

      await pool.query(
        `UPDATE orders SET status = 'rejected' WHERE id = $1`,
        [orderId]
      );

      json(res, 200, { success: true });
      return true;
    }

    return false;
  } catch (err) {
    console.error("[ADMIN ROUTES ERROR]", err);
    json(res, 500, { error: "Internal admin server error" });
    return true;
  }
}

module.exports = { handleAdminRoutes };
