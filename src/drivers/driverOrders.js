"use strict";

const { json, requireDriver } = require("../lib/driverAuth");

/* ======================================================
   HELPERS
====================================================== */

function extractOrderId(pathname) {
  const parts = pathname.split("/");
  return parts.length >= 5 ? String(parts[4]).trim() : null;
}

async function getSession(pool, req, res, opts) {
  try {
    return await requireDriver(pool, req, opts);
  } catch (err) {
    if (!res.writableEnded) {
      json(res, 401, { ok: false, error: err.message || "Unauthorized" });
    }
    return null;
  }
}

/* ======================================================
   DRIVER ORDER ROUTES
====================================================== */

async function handleDriverOrders(req, res, pool, pathname, method) {

  /* ======================================================
     GET /api/driver/orders
  ====================================================== */
  if (pathname === "/api/driver/orders" && method === "GET") {

    const session = await getSession(pool, req, res, { requireSelfie: true });
    if (!session) return true;

    try {
      const { rows } = await pool.query(
        `
        SELECT
          id,
          service_type,
          status,
          pickup_address,
          delivery_address,
          scheduled_date,
          scheduled_time,
          created_at
        FROM orders
        WHERE
          (
            assigned_driver_id = $1
            AND status IN ('assigned', 'en_route')
          )
          OR (
            assigned_driver_id IS NULL
            AND status = 'ready_for_dispatch'
          )
        ORDER BY created_at ASC
        `,
        [session.driver_id]
      );

      json(res, 200, { ok: true, orders: rows });
      return true;

    } catch (err) {
      console.error("[DRIVER] list error:", err);
      json(res, 500, { ok: false, error: "Server error" });
      return true;
    }
  }

  /* ======================================================
     POST /api/driver/order/:id/accept
  ====================================================== */
  if (pathname.startsWith("/api/driver/order/") && pathname.endsWith("/accept") && method === "POST") {

    const session = await getSession(pool, req, res, { requireSelfie: true });
    if (!session) return true;

    const orderId = extractOrderId(pathname);
    if (!orderId) {
      json(res, 400, { ok: false, error: "order_id missing" });
      return true;
    }

    try {
      const { rowCount } = await pool.query(
        `
        UPDATE orders
        SET
          status = 'assigned',
          assigned_driver_id = $2,
          assigned_at = NOW()
        WHERE id = $1
          AND status = 'ready_for_dispatch'
          AND assigned_driver_id IS NULL
        `,
        [orderId, session.driver_id]
      );

      if (!rowCount) {
        json(res, 400, { ok: false, error: "Order not available" });
        return true;
      }

      json(res, 200, { ok: true, order_id: orderId, status: "assigned" });
      return true;

    } catch (err) {
      console.error("[DRIVER] accept error:", err);
      json(res, 500, { ok: false, error: "Server error" });
      return true;
    }
  }

  /* ======================================================
     POST /api/driver/order/:id/start
  ====================================================== */
  if (pathname.startsWith("/api/driver/order/") && pathname.endsWith("/start") && method === "POST") {

    const session = await getSession(pool, req, res, { requireSelfie: true });
    if (!session) return true;

    const orderId = extractOrderId(pathname);
    if (!orderId) {
      json(res, 400, { ok: false, error: "order_id missing" });
      return true;
    }

    try {
      const { rowCount } = await pool.query(
        `
        UPDATE orders
        SET
          status = 'en_route',
          pickup_at = NOW()
        WHERE id = $1
          AND assigned_driver_id = $2
          AND status = 'assigned'
        `,
        [orderId, session.driver_id]
      );

      if (!rowCount) {
        json(res, 400, { ok: false, error: "Order not ready to start" });
        return true;
      }

      json(res, 200, { ok: true, order_id: orderId, status: "en_route" });
      return true;

    } catch (err) {
      console.error("[DRIVER] start error:", err);
      json(res, 500, { ok: false, error: "Server error" });
      return true;
    }
  }

  /* ======================================================
     POST /api/driver/order/:id/complete
  ====================================================== */
  if (pathname.startsWith("/api/driver/order/") && pathname.endsWith("/complete") && method === "POST") {

    const session = await getSession(pool, req, res, { requireSelfie: true });
    if (!session) return true;

    const orderId = extractOrderId(pathname);
    if (!orderId) {
      json(res, 400, { ok: false, error: "order_id missing" });
      return true;
    }

    try {
      const { rowCount } = await pool.query(
        `
        UPDATE orders
        SET
          status = 'completed',
          delivered_at = NOW()
        WHERE id = $1
          AND assigned_driver_id = $2
          AND status = 'en_route'
        `,
        [orderId, session.driver_id]
      );

      if (!rowCount) {
        json(res, 400, { ok: false, error: "Order not in progress" });
        return true;
      }

      json(res, 200, { ok: true, order_id: orderId, status: "completed" });
      return true;

    } catch (err) {
      console.error("[DRIVER] complete error:", err);
      json(res, 500, { ok: false, error: "Server error" });
      return true;
    }
  }

  /* ======================================================
     POST /api/driver/location
  ====================================================== */
  if (pathname === "/api/driver/location" && method === "POST") {

    const session = await getSession(pool, req, res, { requireSelfie: true });
    if (!session) return true;

    try {
      let body = "";
      for await (const chunk of req) body += chunk;

      let data;
      try {
        data = JSON.parse(body || "{}");
      } catch {
        json(res, 400, { ok: false, error: "Invalid JSON body" });
        return true;
      }

      const lat = Number(data.lat);
      const lng = Number(data.lng);

      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        json(res, 400, { ok: false, error: "lat and lng must be numbers" });
        return true;
      }

      await pool.query(
        `
        INSERT INTO driver_locations (
          driver_id,
          latitude,
          longitude,
          recorded_at
        )
        VALUES ($1, $2, $3, NOW())
        `,
        [session.driver_id, lat, lng]
      );

      json(res, 200, { ok: true });
      return true;

    } catch (err) {
      console.error("[DRIVER] location error:", err);
      json(res, 500, { ok: false, error: "Server error" });
      return true;
    }
  }

  return false;
}

module.exports = { handleDriverOrders };