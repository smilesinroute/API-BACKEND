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
 * IMPORTANT:
 * Every response must:
 *   json(...)
 *   return true;
 * or the router will continue and break CORS.
 */

async function handleDriverOrders(req, res, pool, pathname, method) {
  /* =====================================================
     GET /api/driver/orders
  ===================================================== */
  if (pathname === "/api/driver/orders" && method === "GET") {
    try {
      const session = await requireDriver(pool, req, {
        requireSelfie: true,
      });

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
          (assigned_driver_id = $1
            AND status IN ('assigned', 'en_route'))
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
      console.error("[DRIVER ORDERS] list error:", e.message);
      json(res, 401, { error: e.message });
      return true;
    }
  }

  /* =====================================================
     ACCEPT ORDER
  ===================================================== */
  if (
    pathname.startsWith("/api/driver/order/") &&
    pathname.endsWith("/accept") &&
    method === "POST"
  ) {
    try {
      const session = await requireDriver(pool, req, {
        requireSelfie: true,
      });

      const orderId = asId(pathname.split("/")[4]);

      const { rowCount } = await pool.query(
        `
        UPDATE orders
        SET
          status = 'assigned',
          assigned_driver_id = $2,
          assigned_at = NOW()
        WHERE id = $1
          AND status = 'ready_for_dispatch'
        `,
        [orderId, session.driver_id]
      );

      if (!rowCount) {
        json(res, 400, { error: "Order not available" });
        return true;
      }

      json(res, 200, { ok: true, status: "assigned" });
      return true;
    } catch (e) {
      json(res, 400, { error: e.message });
      return true;
    }
  }

  /* =====================================================
     PICKUP PHOTO
  ===================================================== */
  if (
    pathname.startsWith("/api/driver/order/") &&
    pathname.endsWith("/pickup-photo") &&
    method === "POST"
  ) {
    try {
      const session = await requireDriver(pool, req, {
        requireSelfie: true,
      });

      const orderId = asId(pathname.split("/")[4]);

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

      json(res, 200, { ok: true });
      return true;
    } catch (e) {
      json(res, 400, { error: e.message });
      return true;
    }
  }

  /* =====================================================
     START ROUTE (requires pickup photo)
  ===================================================== */
  if (
    pathname.startsWith("/api/driver/order/") &&
    pathname.endsWith("/start") &&
    method === "POST"
  ) {
    try {
      const session = await requireDriver(pool, req, {
        requireSelfie: true,
      });

      const orderId = asId(pathname.split("/")[4]);

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

      json(res, 200, { ok: true, status: "en_route" });
      return true;
    } catch (e) {
      json(res, 400, { error: e.message });
      return true;
    }
  }

  /* =====================================================
     DELIVERY PHOTO
  ===================================================== */
  if (
    pathname.startsWith("/api/driver/order/") &&
    pathname.endsWith("/delivery-photo") &&
    method === "POST"
  ) {
    try {
      const session = await requireDriver(pool, req, {
        requireSelfie: true,
      });

      const orderId = asId(pathname.split("/")[4]);

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

      json(res, 200, { ok: true });
      return true;
    } catch (e) {
      json(res, 400, { error: e.message });
      return true;
    }
  }

  /* =====================================================
     COMPLETE ORDER (requires delivery photo)
  ===================================================== */
  if (
    pathname.startsWith("/api/driver/order/") &&
    pathname.endsWith("/complete") &&
    method === "POST"
  ) {
    try {
      const session = await requireDriver(pool, req, {
        requireSelfie: true,
      });

      const orderId = asId(pathname.split("/")[4]);

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

      json(res, 200, { ok: true, status: "completed" });
      return true;
    } catch (e) {
      json(res, 400, { error: e.message });
      return true;
    }
  }

  /* =====================================================
     LIVE GPS TRACKING
     POST /api/driver/location
  ===================================================== */
  if (pathname === "/api/driver/location" && method === "POST") {
    try {
      const session = await requireDriver(pool, req, {
        requireSelfie: true,
      });

      let body = "";
      for await (const chunk of req) body += chunk;
      const data = JSON.parse(body);

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
        [session.driver_id, data.lat, data.lng]
      );

      json(res, 200, { ok: true });
      return true;
    } catch (e) {
      json(res, 400, { error: e.message });
      return true;
    }
  }

  return false;
}

module.exports = { handleDriverOrders };
