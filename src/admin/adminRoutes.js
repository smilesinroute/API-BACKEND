"use strict";

const { requireAdmin } = require("./adminAuth");
const { sendCustomerPaymentLink } = require("../lib/dispatchEmails");
const { createPaymentSession } = require("../lib/stripeCheckout");

/**
 * ======================================================
 * ADMIN ROUTES (Production — Manual Router)
 * ======================================================
 * - NO Express
 * - Auth: Authorization: Bearer <ADMIN_API_KEY>
 * - Orders table is source of truth
 * - Explicit validation + explicit errors (no silent 500s)
 */

function jsonError(json, res, statusCode, message) {
  json(res, statusCode, { error: message });
}

function parseOrderId(pathname) {
  // Expected:
  //   /admin/orders/:id/approve
  //   /admin/orders/:id/reject
  const parts = String(pathname || "").split("/").filter(Boolean);
  // ["admin","orders",":id","approve"]
  if (parts.length < 4) return null;
  if (parts[0] !== "admin" || parts[1] !== "orders") return null;
  return parts[2] || null;
}

function laneForStatus(status) {
  switch (status) {
    case "confirmed_pending_payment":
      return "action_required";
    case "approved_pending_payment":
      return "awaiting_payment";
    case "paid":
    case "assigned":
    case "in_progress":
      return "active";
    default:
      return null;
  }
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function loadOrder(pool, orderId) {
  const { rows } = await pool.query(`SELECT * FROM orders WHERE id = $1`, [
    orderId,
  ]);
  return rows[0] || null;
}

async function handleDashboard(pool) {
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

  return {
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
  };
}

async function handleAdminRoutes(req, res, pool, pathname, method, json) {
  try {
    /* ======================================================
       DASHBOARD SNAPSHOT
       GET /admin/dashboard
    ====================================================== */
    if (pathname === "/admin/dashboard" && method === "GET") {
      requireAdmin(req);

      const payload = await handleDashboard(pool);
      json(res, 200, payload);
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

      const orderId = parseOrderId(pathname);
      if (!orderId) {
        jsonError(json, res, 400, "Missing order ID");
        return true;
      }

      const order = await loadOrder(pool, orderId);
      if (!order) {
        jsonError(json, res, 404, "Order not found");
        return true;
      }

      if (order.status !== "confirmed_pending_payment") {
        jsonError(json, res, 400, "Order is not in an approvable state");
        return true;
      }

      const email = String(order.customer_email || "").trim();
      if (!email) {
        jsonError(json, res, 400, "Customer email missing");
        return true;
      }

      const total = toNumber(order.total_amount);
      if (total === null || total <= 0) {
        jsonError(json, res, 400, "Order total is invalid for payment");
        return true;
      }

      // Create Stripe session (this is the only step that can fail externally)
      let session;
      try {
        session = await createPaymentSession({
          ...order,
          customer_email: email,
          total_amount: total,
        });
      } catch (e) {
        console.error("[STRIPE] createPaymentSession failed", {
          orderId: order.id,
          message: e && e.message ? e.message : String(e),
        });
        jsonError(json, res, 500, "Stripe session creation failed");
        return true;
      }

      // Persist Stripe session details before email
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

      // Fire-and-forget email (do not block the approval response)
      sendCustomerPaymentLink({
        to: email,
        paymentLink: session.url,
        order,
      }).catch((err) => {
        console.error("[EMAIL] Payment link failed", {
          orderId: order.id,
          error: err && err.message ? err.message : String(err),
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

      const orderId = parseOrderId(pathname);
      if (!orderId) {
        jsonError(json, res, 400, "Missing order ID");
        return true;
      }

      const { rowCount } = await pool.query(
        `UPDATE orders SET status = 'rejected' WHERE id = $1`,
        [orderId]
      );

      if (!rowCount) {
        jsonError(json, res, 404, "Order not found");
        return true;
      }

      json(res, 200, { success: true, orderId });
      return true;
    }

    return false;
  } catch (err) {
    console.error("[ADMIN ROUTES ERROR]", err);
    json(res, err.statusCode || 500, {
      error: err && err.message ? err.message : "Internal admin server error",
    });
    return true;
  }
}

module.exports = { handleAdminRoutes };
