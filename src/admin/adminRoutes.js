"use strict";

const { requireAdmin } = require("./adminAuth");
const { sendCustomerPaymentLink } = require("../lib/dispatchEmails");
const { createPaymentSession } = require("../lib/stripeCheckout");

/**
 * ======================================================
 * ADMIN ROUTES (Production)
 * ======================================================
 * - Manual router (NO Express)
 * - Auth via Authorization: Bearer <ADMIN_API_KEY>
 * - Source of truth: orders table
 * - Clear, safe error handling (no silent 500s)
 */

function getIdFromPath(pathname) {
  // /admin/orders/:id/approve  OR  /admin/orders/:id/reject
  const parts = String(pathname || "").split("/").filter(Boolean);
  // ["admin","orders",":id","approve"]
  return parts[2] || null;
}

function laneForStatus(status) {
  if (status === "confirmed_pending_payment") return "action_required";
  if (status === "approved_pending_payment") return "awaiting_payment";
  if (status === "paid" || status === "assigned" || status === "in_progress")
    return "active";
  return null;
}

function safeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function handleAdminRoutes(req, res, pool, pathname, method, json) {
  try {
    /* ======================================================
       DASHBOARD SNAPSHOT
       GET /admin/dashboard
    ====================================================== */
    if (pathname === "/admin/dashboard" && method === "GET") {
      requireAdmin(req);

      const { rows: orders } = await pool.query(
        `
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
        `
      );

      const lanes = {
        action_required: [],
        awaiting_payment: [],
        active: [],
      };

      for (const o of orders) {
        const lane = laneForStatus(o.status);
        if (lane) lanes[lane].push(o);
      }

      const [driversRes, revenueRes] = await Promise.all([
        pool.query(`SELECT COUNT(*)::int AS count FROM drivers`),
        pool.query(
          `
          SELECT COALESCE(SUM(total_amount), 0)::numeric AS total
          FROM orders
          WHERE payment_status = 'paid'
            AND paid_at IS NOT NULL
            AND paid_at::date = CURRENT_DATE
          `
        ),
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
    ====================================================== */
    if (
      pathname.startsWith("/admin/orders/") &&
      pathname.endsWith("/approve") &&
      method === "POST"
    ) {
      requireAdmin(req);

      const orderId = getIdFromPath(pathname);
      if (!orderId) {
        json(res, 400, { error: "Missing order ID" });
        return true;
      }

      const { rows } = await pool.query(`SELECT * FROM orders WHERE id = $1`, [
        orderId,
      ]);

      const order = rows[0];
      if (!order) {
        json(res, 404, { error: "Order not found" });
        return true;
      }

      if (order.status !== "confirmed_pending_payment") {
        json(res, 400, { error: "Order is not in an approvable state" });
        return true;
      }

      if (!order.customer_email) {
        json(res, 400, { error: "Customer email missing" });
        return true;
      }

      // Prevent Stripe session failures from invalid totals (0, null, NaN)
      const total = safeNumber(order.total_amount);
      if (total === null || total <= 0) {
        json(res, 400, { error: "Order total is invalid for payment" });
        return true;
      }

      let session;
      try {
        session = await createPaymentSession(order);
      } catch (e) {
        // Surface the real cause instead of generic "Internal admin server error"
        console.error("[STRIPE] createPaymentSession failed", {
          orderId: order.id,
          message: e?.message,
        });
        json(res, 500, { error: "Stripe session creation failed" });
        return true;
      }

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

      // Fire-and-forget email (do not block approval response)
      sendCustomerPaymentLink({
        to: order.customer_email,
        paymentLink: session.url,
        order,
      }).catch((err) => {
        console.error("[EMAIL] Payment link failed", {
          orderId: order.id,
          error: err?.message,
        });
      });

      json(res, 200, { success: true, orderId: order.id });
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

      const orderId = getIdFromPath(pathname);
      if (!orderId) {
        json(res, 400, { error: "Missing order ID" });
        return true;
      }

      const { rowCount } = await pool.query(
        `UPDATE orders SET status = 'rejected' WHERE id = $1`,
        [orderId]
      );

      if (!rowCount) {
        json(res, 404, { error: "Order not found" });
        return true;
      }

      json(res, 200, { success: true, orderId });
      return true;
    }

    return false;
  } catch (err) {
    console.error("[ADMIN ROUTES ERROR]", err);
    json(res, err.statusCode || 500, {
      error: err.message || "Internal admin server error",
    });
    return true;
  }
}

module.exports = { handleAdminRoutes };
