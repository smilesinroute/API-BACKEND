"use strict";

const { json, requireDriver } = require("../lib/driverAuth");

function asId(v) {
  return String(v || "").trim();
}

/**
 * Driver Orders – Step 2A
 * - GET  /api/driver/orders
 * - POST /api/driver/order/:id/start
 */
async function handleDriverOrders(req, res, pool, pathname, method) {
  /* =========================
     GET /api/driver/orders
  ========================= */
  if (pathname === "/api/driver/orders" && method === "GET") {
    try {
      const session = await requireDriver(pool, req, { requireSelfie: true });

      const { rows } = await pool.query(
        `
        SELECT
          id,
          service_type,
          status,
          pickup_address,
          delivery_address,
          scheduled_date,
          scheduled_time
        FROM orders
        WHERE assigned_driver_id = $1
          AND status IN ('ready_for_dispatch', 'en_route')
        ORDER BY created_at ASC
        `,
        [session.driver_id]
      );

      return json(res, 200, { ok: true, orders: rows });
    } catch (e) {
      console.error("[DRIVER ORDERS] list error:", e.message);
      return json(res, 401, { error: e.message });
    }
  }

  /* =========================
     POST /api/driver/order/:id/start
  ========================= */
  if (pathname.startsWith("/api/driver/order/") && pathname.endsWith("/start") && method === "POST") {
    try {
      const session = await requireDriver(pool, req, { requireSelfie: true });

      const orderId = asId(pathname.split("/")[4]);
      if (!orderId) return json(res, 400, { error: "order_id missing" });

      const { rowCount } = await pool.query(
        `
        UPDATE orders
        SET
          status = 'en_route',
          pickup_at = NOW()
        WHERE id = $1
          AND assigned_driver_id = $2
          AND status = 'ready_for_dispatch'
        `,
        [orderId, session.driver_id]
      );

      if (!rowCount) {
        return json(res, 400, {
          error: "Order not found, not assigned, or invalid state",
        });
      }

      return json(res, 200, {
        ok: true,
        order_id: orderId,
        status: "en_route",
      });
    } catch (e) {
      console.error("[DRIVER ORDERS] start error:", e.message);
      return json(res, 400, { error: e.message });
    }
  }

  return false;
}

module.exports = { handleDriverOrders };
