"use strict";

/**
 * Admin Orders Actions (Production)
 * ---------------------------------
 * - Admin / Ops only
 * - Order assignment is LOCKED (no driver acceptance)
 * - Safe state transitions
 */

async function handleAdminOrders(req, res, pool, pathname, method, json) {
  if (!pathname.startsWith("/api/orders")) return false;

  const parts = pathname.split("/").filter(Boolean);
  const orderId = parts[2] || null;

  /* ======================================================
     POST /api/orders/:id/assign-driver
     (Admin assigns driver — irreversible)
  ====================================================== */
  if (
    method === "POST" &&
    parts.length === 4 &&
    parts[3] === "assign-driver"
  ) {
    const body = await readJson(req);
    const driverId = body.driver_id;

    if (!orderId || !driverId) {
      return json(res, 400, {
        error: "order_id and driver_id are required",
      });
    }

    /* ---- fetch order state ---- */
    const { rows } = await pool.query(
      `
      SELECT
        status,
        payment_status,
        assigned_driver_id
      FROM orders
      WHERE id = $1
      LIMIT 1
      `,
      [orderId]
    );

    if (!rows.length) {
      return json(res, 404, { error: "Order not found" });
    }

    const order = rows[0];

    /* ---- hard locks ---- */
    if (order.assigned_driver_id) {
      return json(res, 409, {
        error: "Order already assigned to a driver",
      });
    }

    if (order.payment_status !== "paid") {
      return json(res, 400, {
        error: "Order must be paid before assignment",
      });
    }

    if (order.status !== "ready_for_dispatch") {
      return json(res, 400, {
        error: `Order must be in 'ready_for_dispatch' status`,
      });
    }

    /* ---- assign + lock ---- */
    const updated = await pool.query(
      `
      UPDATE orders
      SET
        assigned_driver_id = $2,
        status = 'in_progress'
      WHERE id = $1
      RETURNING *
      `,
      [orderId, driverId]
    );

    return json(res, 200, updated.rows[0]);
  }

  return false;
}

/* ======================================================
   Minimal JSON body reader
====================================================== */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
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

module.exports = { handleAdminOrders };
