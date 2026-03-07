
/**
 * Admin Orders Actions (Production)
 * ---------------------------------
 * Admin / Ops order controls
 *
 * Endpoints:
 * POST /api/orders/:id/assign-driver
 * POST /api/orders/:id/cancel
 * POST /api/orders/:id/expire-payment
 */

async function handleAdminOrders(req, res, pool, pathname, method, json) {
  if (!pathname.startsWith("/api/orders")) return false;

  const parts = pathname.split("/").filter(Boolean);
  const orderId = parts[2] || null;

  /* ======================================================
     POST /api/orders/:id/assign-driver
     Admin assigns driver (irreversible)
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

    /* fetch order */

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

    /* safety checks */

    if (order.assigned_driver_id) {
      return json(res, 409, {
        error: "Order already assigned",
      });
    }

    if (order.payment_status !== "paid") {
      return json(res, 400, {
        error: "Order must be paid before assignment",
      });
    }

    if (order.status !== "ready_for_dispatch") {
      return json(res, 400, {
        error: "Order must be ready_for_dispatch",
      });
    }

    /* assign driver */

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

  /* ======================================================
     POST /api/orders/:id/cancel
     Admin cancels order
  ====================================================== */

  if (
    method === "POST" &&
    parts.length === 4 &&
    parts[3] === "cancel"
  ) {
    if (!orderId) {
      return json(res, 400, { error: "order_id required" });
    }

    const result = await pool.query(
      `
      UPDATE orders
      SET status = 'cancelled'
      WHERE id = $1
      RETURNING *
      `,
      [orderId]
    );

    if (!result.rows.length) {
      return json(res, 404, { error: "Order not found" });
    }

    return json(res, 200, result.rows[0]);
  }

  /* ======================================================
     POST /api/orders/:id/expire-payment
     Expire unpaid order
  ====================================================== */

  if (
    method === "POST" &&
    parts.length === 4 &&
    parts[3] === "expire-payment"
  ) {
    if (!orderId) {
      return json(res, 400, { error: "order_id required" });
    }

    const result = await pool.query(
      `
      UPDATE orders
      SET status = 'payment_expired'
      WHERE id = $1
      AND payment_status != 'paid'
      RETURNING *
      `,
      [orderId]
    );

    if (!result.rows.length) {
      return json(res, 404, {
        error: "Order not found or already paid",
      });
    }

    return json(res, 200, result.rows[0]);
  }

  return false;
}

/* ======================================================
   JSON BODY READER
====================================================== */

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";

    req.on("data", chunk => {
      data += chunk;
    });

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

module.exports = {
  handleAdminOrders,
};