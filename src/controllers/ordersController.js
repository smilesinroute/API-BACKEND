"use strict";

const { createCourierRequest } = require("../lib/courierRequest");

/*
Orders Controller
=================

Handles:
- Order creation
- Order retrieval
- Status transitions
- Manual payment overrides

Stripe webhook handles automatic payment confirmation.
*/

/* ======================================================
ORDER STATUS STATE MACHINE
====================================================== */

const ORDER_TRANSITIONS = {
  pending_admin_review: ["approved_pending_payment", "rejected"],
  approved_pending_payment: ["paid", "rejected"],
  paid: ["ready_for_dispatch"],
  ready_for_dispatch: ["in_progress"],
  in_progress: ["completed"],
};

/* ======================================================
HELPERS
====================================================== */

function isValidEmail(value) {
  if (!value || typeof value !== "string") return false;
  const email = value.trim().toLowerCase();
  return email.includes("@") && email.length >= 5;
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function readJson(req) {
  return new Promise((resolve, reject) => {

    let data = "";
    let tooLarge = false;
    let size = 0;

    req.on("data", chunk => {
      if (tooLarge) return;
      size += Buffer.byteLength(chunk);
      if (size > 16384) {
        tooLarge = true;
        data = "";
        reject(Object.assign(new Error("Request details are too large."), { statusCode: 413 }));
        return;
      }
      data += chunk;
    });

    req.on("end", () => {
      if (tooLarge) return;
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
MAIN HANDLER
====================================================== */

async function handleOrders(req, res, pool, pathname, method, json) {

  if (!pathname.startsWith("/api/orders")) return false;

  const parts = pathname.split("/").filter(Boolean);
  const id = parts[2] || null;

  /* ======================================================
  GET /api/orders
  ====================================================== */

  if (method === "GET" && parts.length === 2) {

    const { rows } = await pool.query(`
      SELECT *
      FROM orders
      ORDER BY created_at DESC
    `);

    return json(res, 200, rows);
  }

  /* ======================================================
  GET /api/orders/:id
  ====================================================== */

  if (method === "GET" && parts.length === 3 && id) {

    const { rows } = await pool.query(
      `SELECT * FROM orders WHERE id = $1 LIMIT 1`,
      [id]
    );

    if (!rows.length) {
      return json(res, 404, { error: "Order not found" });
    }

    return json(res, 200, rows[0]);
  }

  /* ======================================================
  POST /api/orders
  Customer creates courier OR notary order
  ====================================================== */

  if (method === "POST" && parts.length === 2) {

    try {
      const body = await readJson(req);
      const order = await createCourierRequest(pool, body);
      // A notification problem must not turn a saved request into a failed
      // submission. The pending request remains visible in the admin queue.
      if (process.env.DISPATCH_EMAIL) {
        try {
          require("../lib/dispatchEmails").sendDispatchNotification(order)
            .catch(error => console.error("[REQUEST NOTIFICATION]", error.message));
        } catch (error) {
          console.error("[REQUEST NOTIFICATION]", error.message);
        }
      }
      return json(res, 201, {
        id: order.id, status: order.status, payment_status: order.payment_status,
        scheduled_date: order.scheduled_date, scheduled_time: order.scheduled_time,
        requested_window: order.requested_window, timezone: order.timezone,
        total_amount: Number(order.total_amount), requiresConfirmation: true,
      });
    } catch (error) {
      const status = error.statusCode || (error.message === "Invalid JSON body" ? 400 : 500);
    if (status >= 500) console.error("[COURIER REQUEST]", error.message);
      return json(res, status, { error: status === 500
        ? "Unable to save your request. Please try again or contact dispatch."
        : error.message });
    }
  }

  /* ======================================================
  PUT /api/orders/:id/status
  Locked status transitions
  ====================================================== */

  if (
    method === "PUT" &&
    parts.length === 4 &&
    parts[3] === "status"
  ) {

    const body = await readJson(req);
    const nextStatus = String(body.status || "").trim();

    if (!nextStatus) {
      return json(res, 400, { error: "status is required" });
    }

    const { rows } = await pool.query(
      `
      SELECT status
      FROM orders
      WHERE id = $1
      LIMIT 1
      `,
      [id]
    );

    if (!rows.length) {
      return json(res, 404, { error: "Order not found" });
    }

    const currentStatus = rows[0].status;
    const allowedNext = ORDER_TRANSITIONS[currentStatus] || [];

    if (!allowedNext.includes(nextStatus)) {

      return json(res, 409, {
        error: `Invalid status transition: ${currentStatus} → ${nextStatus}`,
        allowed: allowedNext
      });

    }

    const updated = await pool.query(
      `
      UPDATE orders
      SET status = $2
      WHERE id = $1
      RETURNING *
      `,
      [id, nextStatus]
    );

    return json(res, 200, updated.rows[0]);
  }

  /* ======================================================
  POST /api/orders/:id/manual-pay
  Admin manual payment override
  ====================================================== */

  if (
    method === "POST" &&
    parts.length === 4 &&
    parts[3] === "manual-pay"
  ) {

    const body = await readJson(req);
    const note = String(body.note || "").trim();

    if (!note) {
      return json(res, 400, {
        error: "paid_note is required for manual payments"
      });
    }

    const { rows } = await pool.query(
      `
      SELECT status, payment_status
      FROM orders
      WHERE id = $1
      LIMIT 1
      `,
      [id]
    );

    if (!rows.length) {
      return json(res, 404, { error: "Order not found" });
    }

    const order = rows[0];

    if (order.payment_status === "paid") {
      return json(res, 409, { error: "Order is already paid" });
    }

    if (order.status !== "approved_pending_payment") {
      return json(res, 400, {
        error: `Cannot manually pay order in status '${order.status}'`
      });
    }

    const updated = await pool.query(
      `
      UPDATE orders
      SET
        payment_status = 'paid',
        paid_at = NOW(),
        paid_via = 'manual',
        paid_note = $2,
        status = 'paid'
      WHERE id = $1
      RETURNING *
      `,
      [id, note]
    );

    return json(res, 200, updated.rows[0]);
  }

  return false;
}

module.exports = { handleOrders };
