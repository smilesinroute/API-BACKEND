"use strict";

const { requireAdmin } = require("./adminAuth");
const { sendCustomerPaymentLink } = require("../lib/dispatchEmails");
const { createPaymentSession } = require("../lib/stripeCheckout");

/**
 * ======================================================
 * ADMIN ROUTES (Production — Manual Router)
 * ======================================================
 * - Plain Node.js (NO Express)
 * - Auth via Authorization: Bearer <ADMIN_API_KEY>
 * - Orders table is the single source of truth
 * - Explicit state transitions (locked)
 * - Correct error propagation (401/403 preserved)
 */

/* ======================================================
   RESPONSE HELPERS
====================================================== */
function jsonError(json, res, status, message, extra) {
  const payload = { error: message };
  if (extra && typeof extra === "object") Object.assign(payload, extra);
  return json(res, status, payload);
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Expected:
 * - /admin/orders/:id/approve
 * - /admin/orders/:id/reject
 * - /admin/orders/:id/assign
 *
 * Returns { orderId, action } or null
 */
function parseOrderActionPath(pathname) {
  const parts = String(pathname || "").split("/").filter(Boolean);
  // ["admin","orders",":id",":action"]
  if (parts.length !== 4) return null;
  if (parts[0] !== "admin" || parts[1] !== "orders") return null;

  const orderId = parts[2];
  const action = parts[3];

  if (!isNonEmptyString(orderId)) return null;
  if (!["approve", "reject", "assign"].includes(action)) return null;

  return { orderId, action };
}

async function loadOrder(pool, orderId) {
  const { rows } = await pool.query(
    `SELECT * FROM orders WHERE id = $1 LIMIT 1`,
    [orderId]
  );
  return rows[0] || null;
}

function laneForStatus(status) {
  switch (status) {
    case "confirmed_pending_payment":
      return "action_required";
    case "approved_pending_payment":
      return "awaiting_payment";
    case "paid":
    case "ready_for_dispatch":
    case "assigned":
    case "in_progress":
      return "active";
    default:
      return null;
  }
}

/* ======================================================
   DASHBOARD AGGREGATION
====================================================== */
async function buildDashboardPayload(pool) {
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
    const lane = laneForStatus(order.status);
    if (lane) lanes[lane].push(order);
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

  return {
    stats: {
      awaitingApproval: lanes.action_required.length,
      awaitingPayment: lanes.awaiting_payment.length,
      activeOrders: lanes.active.length,
      totalDrivers: driversRes.rows[0]?.count ?? 0,
      revenueToday: Number(revenueRes.rows[0]?.total ?? 0),
    },
    lanes,
    meta: {
      system: "live",
      checkedAt: new Date().toISOString(),
    },
  };
}

/* ======================================================
   BODY PARSER
====================================================== */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/* ======================================================
   ROUTE HANDLERS
====================================================== */
async function approveOrder(pool, json, res, orderId) {
  const order = await loadOrder(pool, orderId);
  if (!order) return jsonError(json, res, 404, "Order not found");

  if (order.status !== "confirmed_pending_payment") {
    return jsonError(
      json,
      res,
      409,
      `Order cannot be approved from status '${order.status}'`
    );
  }

  const email = String(order.customer_email || "").trim();
  const total = toNumber(order.total_amount);

  if (!email) return jsonError(json, res, 400, "Customer email missing");
  if (!total || total <= 0) return jsonError(json, res, 400, "Invalid order total");

  let session;
  try {
    session = await createPaymentSession({
      ...order,
      customer_email: email,
      total_amount: total,
    });
  } catch (err) {
    console.error("[STRIPE] createPaymentSession failed", err);
    return jsonError(json, res, 502, "Stripe session creation failed");
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

  // Fire-and-forget email: don't block the request
  sendCustomerPaymentLink({
    to: email,
    paymentLink: session.url,
    order,
  }).catch((err) => console.error("[EMAIL] Payment email failed", err));

  return json(res, 200, { success: true, orderId: order.id });
}

async function rejectOrder(pool, json, res, orderId) {
  const { rowCount } = await pool.query(
    `UPDATE orders SET status = 'rejected' WHERE id = $1`,
    [orderId]
  );

  if (!rowCount) return jsonError(json, res, 404, "Order not found");
  return json(res, 200, { success: true, orderId });
}

async function assignDriver(pool, json, res, req, orderId) {
  const body = await readJson(req);
  const driverId = String(body.driver_id || "").trim();

  if (!driverId) return jsonError(json, res, 400, "driver_id is required");

  const order = await loadOrder(pool, orderId);
  if (!order) return jsonError(json, res, 404, "Order not found");

  if (!["paid", "ready_for_dispatch"].includes(order.status)) {
    return jsonError(
      json,
      res,
      409,
      `Order cannot be assigned from status '${order.status}'`
    );
  }

  if (order.assigned_driver_id) {
    return jsonError(json, res, 409, "Order already assigned");
  }

  const driverCheck = await pool.query(
    `SELECT id FROM drivers WHERE id = $1 LIMIT 1`,
    [driverId]
  );
  if (!driverCheck.rowCount) return jsonError(json, res, 404, "Driver not found");

  const { rows } = await pool.query(
    `
    UPDATE orders
    SET
      assigned_driver_id = $2,
      status = 'assigned'
    WHERE id = $1
    RETURNING *
    `,
    [orderId, driverId]
  );

  return json(res, 200, rows[0]);
}

/* ======================================================
   MAIN ADMIN ROUTER
====================================================== */
async function handleAdminRoutes(req, res, pool, pathname, method, json) {
  try {
    // Only handle /admin/*
    if (!String(pathname || "").startsWith("/admin")) return false;

    /* ================= DASHBOARD ================= */
    if (pathname === "/admin/dashboard" && method === "GET") {
      requireAdmin(req);
      const payload = await buildDashboardPayload(pool);
      json(res, 200, payload);
      return true;
    }

    /* ================= LIST ORDERS ================= */
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

    /* ================= ORDER ACTIONS ================= */
    const actionMatch = parseOrderActionPath(pathname);

    if (actionMatch && method === "POST") {
      requireAdmin(req);

      const { orderId, action } = actionMatch;

      if (action === "approve") {
        await approveOrder(pool, json, res, orderId);
        return true;
      }

      if (action === "reject") {
        await rejectOrder(pool, json, res, orderId);
        return true;
      }

      if (action === "assign") {
        await assignDriver(pool, json, res, req, orderId);
        return true;
      }
    }

    return false;
  } catch (err) {
    // Preserve auth errors (requireAdmin throws with statusCode)
    if (err && err.statusCode) {
      json(res, err.statusCode, { error: err.message });
      return true;
    }

    console.error("[ADMIN ROUTES ERROR]", err);
    json(res, 500, { error: "Internal admin server error" });
    return true;
  }
}

module.exports = { handleAdminRoutes };
