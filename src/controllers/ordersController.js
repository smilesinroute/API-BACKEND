"use strict";

/**
 * Orders Controller (Unified Production)
 * ---------------------------------------
 * Exposes /api/orders via Node router
 * Handles:
 *   - Order creation (courier + notary)
 *   - Retrieval
 *   - Locked status transitions (admin / ops)
 *   - Manual payment override
 *
 * Stripe webhook handles automatic payment confirmation.
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
    const body = await readJson(req);

    const email = String(body.customer_email || "")
      .trim()
      .toLowerCase();

    if (!isValidEmail(email)) {
      return json(res, 400, {
        error: "Valid customer_email is required",
      });
    }

    if (!body.service_type) {
      return json(res, 400, {
        error: "service_type is required",
      });
    }

    const totalAmount = toNumber(body.total_amount, 0);

    const { rows } = await pool.query(
      `
      INSERT INTO orders (
        service_type,
        customer_id,
        customer_email,
        pickup_address,
        delivery_address,
        scheduled_date,
        scheduled_time,
        distance_miles,
        total_amount,
        notes,
        status,
        payment_status
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        'pending_admin_review',
        'unpaid'
      )
      RETURNING *
      `,
      [
        body.service_type, // courier OR notary
        body.customer_id || null,
        email,
        body.pickup_address || null,
        body.delivery_address || null,
        body.scheduled_date || null,
        body.scheduled_time || null,
        toNumber(body.distance_miles, 0),
        totalAmount,
        body.notes || null,
      ]
    );

    return json(res, 201, rows[0]);
  }

  /* ======================================================
     PUT /api/orders/:id/status
     Locked status transitions (Admin / Ops)
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
        allowed: allowedNext,
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
        error: "paid_note is required for manual payments",
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
      return json(res, 409, {
        error: "Order is already paid",
      });
    }

    if (order.status !== "approved_pending_payment") {
      return json(res, 400, {
        error: `Cannot manually pay order in status '${order.status}'`,
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

/* ======================================================
   MINIMAL JSON BODY READER
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

module.exports = { handleOrders };