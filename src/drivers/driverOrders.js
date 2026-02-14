"use strict";

const { json, requireDriver } = require("../lib/driverAuth");

function asId(v) {
  return String(v || "").trim();
}

/**
 * =====================================================
 * DRIVER ORDER LIFECYCLE ROUTES
 * =====================================================
 *
 * GET  /api/driver/orders
 * POST /api/driver/order/:id/accept
 * POST /api/driver/order/:id/pickup-photo
 * POST /api/driver/order/:id/start
 * POST /api/driver/order/:id/delivery-photo
 * POST /api/driver/order/:id/complete
 * POST /api/driver/location
 *
 * CRITICAL:
 * requireDriver() may already send the response on auth failure.
 * If that happens, we MUST NOT send another response (prevents headers-sent crash).
 */

async function getSession(pool, req, res, opts) {
  try {
    return await requireDriver(pool, req, opts);
  } catch (e) {
    // requireDriver already responded (401), so we stop here safely.
    if (!res.writableEnded) {
      // fallback safety (only if requireDriver didn't respond for some reason)
      json(res, 401, { error: e.message || "Unauthorized" });
    }
    return null;
  }
}

async function handleDriverOrders(req, res, pool, pathname, method) {
  /* =====================================================
     GET /api/driver/orders
  ===================================================== */
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
          scheduled_time
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
    } catch (e) {
      console.error("[DRIVER ORDERS] list error:", e);
      json(res, 500, { error: "Server error" });
      return true;
    }
  }

  /* =====================================================
     POST /api/driver/order/:id/accept
  ===================================================== */
  if (pathname.startsWith("/api/driver/order/") && pathname.endsWith("/accept") && method === "POST") {
    const session = await getSession(pool, req, res, { requireSelfie: true });
    if (!session) return true;

    try {
      const orderId = asId(pathname.split("/")[4]);
      if (!orderId) {
        json(res, 400, { error: "order_id missing" });
        return true;
      }

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
        json(res, 400, { error: "Order not available" });
        return true;
      }

      json(res, 200, { ok: true, order_id: orderId, status: "assigned" });
      return true;
    } catch (e) {
      console.error("[DRIVER ORDERS] accept error:", e);
      json(res, 500, { error: "Server error" });
      return true;
    }
  }

  /* =====================================================
     POST /api/driver/order/:id/pickup-photo
  ===================================================== */
  if (pathname.startsWith("/api/driver/order/") && pathname.endsWith("/pickup-photo") && method === "POST") {
    const session = await getSession(pool, req, res, { requireSelfie: true });
    if (!session) return true;

    try {
      const orderId = asId(pathname.split("/")[4]);
      if (!orderId) {
        json(res, 400, { error: "order_id missing" });
        return true;
      }

      await pool.query(
        `
        UPDATE orders
        SET
          pickup_photo_taken = true,
          pickup_photo_at = NOW()
        WHERE id = $1
          AND assigned_driver_id = $2
        `,
        [orderId, session.driver_id]
      );

      json(res, 200, { ok: true, order_id: orderId });
      return true;
    } catch (e) {
      console.error("[DRIVER ORDERS] pickup-photo error:", e);
      json(res, 500, { error: "Server error" });
      return true;
    }
  }

  /* =====================================================
     POST /api/driver/order/:id/start
     Requires pickup photo
  ===================================================== */
  if (pathname.startsWith("/api/driver/order/") && pathname.endsWith("/start") && method === "POST") {
    const session = await getSession(pool, req, res, { requireSelfie: true });
    if (!session) return true;

    try {
      const orderId = asId(pathname.split("/")[4]);
      if (!orderId) {
        json(res, 400, { error: "order_id missing" });
        return true;
      }

      const { rowCount } = await pool.query(
        `
        UPDATE orders
        SET
          status = 'en_route',
          pickup_at = NOW()
        WHERE id = $1
          AND assigned_driver_id = $2
          AND status = 'assigned'
          AND pickup_photo_taken = true
        `,
        [orderId, session.driver_id]
      );

      if (!rowCount) {
        json(res, 400, { error: "Pickup photo required" });
        return true;
      }

      json(res, 200, { ok: true, order_id: orderId, status: "en_route" });
      return true;
    } catch (e) {
      console.error("[DRIVER ORDERS] start error:", e);
      json(res, 500, { error: "Server error" });
      return true;
    }
  }

  /* =====================================================
     POST /api/driver/order/:id/delivery-photo
  ===================================================== */
  if (pathname.startsWith("/api/driver/order/") && pathname.endsWith("/delivery-photo") && method === "POST") {
    const session = await getSession(pool, req, res, { requireSelfie: true });
    if (!session) return true;

    try {
      const orderId = asId(pathname.split("/")[4]);
      if (!orderId) {
        json(res, 400, { error: "order_id missing" });
        return true;
      }

      await pool.query(
        `
        UPDATE orders
        SET
          delivery_photo_taken = true,
          delivery_photo_at = NOW()
        WHERE id = $1
          AND assigned_driver_id = $2
        `,
        [orderId, session.driver_id]
      );

      json(res, 200, { ok: true, order_id: orderId });
      return true;
    } catch (e) {
      console.error("[DRIVER ORDERS] delivery-photo error:", e);
      json(res, 500, { error: "Server error" });
      return true;
    }
  }

  /* =====================================================
     POST /api/driver/order/:id/complete
     Requires delivery photo
  ===================================================== */
  if (pathname.startsWith("/api/driver/order/") && pathname.endsWith("/complete") && method === "POST") {
    const session = await getSession(pool, req, res, { requireSelfie: true });
    if (!session) return true;

    try {
      const orderId = asId(pathname.split("/")[4]);
      if (!orderId) {
        json(res, 400, { error: "order_id missing" });
        return true;
      }

      const { rowCount } = await pool.query(
        `
        UPDATE orders
        SET
          status = 'completed',
          delivered_at = NOW()
        WHERE id = $1
          AND assigned_driver_id = $2
          AND status = 'en_route'
          AND delivery_photo_taken = true
        `,
        [orderId, session.driver_id]
      );

      if (!rowCount) {
        json(res, 400, { error: "Delivery photo required" });
        return true;
      }

      json(res, 200, { ok: true, order_id: orderId, status: "completed" });
      return true;
    } catch (e) {
      console.error("[DRIVER ORDERS] complete error:", e);
      json(res, 500, { error: "Server error" });
      return true;
    }
  }

  /* =====================================================
     POST /api/driver/location
  ===================================================== */
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
        json(res, 400, { error: "Invalid JSON body" });
        return true;
      }

      const lat = Number(data.lat);
      const lng = Number(data.lng);

      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        json(res, 400, { error: "lat and lng must be numbers" });
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
    } catch (e) {
      console.error("[DRIVER ORDERS] location error:", e);
      json(res, 500, { error: "Server error" });
      return true;
    }
  }

  return false;
}

module.exports = { handleDriverOrders };
