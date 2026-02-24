"use strict";

const express = require("express");
const router = express.Router();
const pool = require("../utils/db");

/* ======================================================
   DRIVER AUTH MIDDLEWARE
   TEMP: token = driver ID
====================================================== */
function requireDriver(req, res, next) {
  const header = String(req.headers.authorization || "");

  if (!header.toLowerCase().startsWith("bearer ")) {
    return res.status(401).json({
      ok: false,
      error: "Missing Authorization token",
    });
  }

  const token = header.replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    return res.status(401).json({
      ok: false,
      error: "Invalid Authorization token",
    });
  }

  req.driverId = token;
  next();
}

router.use(requireDriver);

/* ======================================================
   HELPERS
====================================================== */
function serverError(res, err, label) {
  console.error(`[DRIVER] ${label}:`, err);
  return res.status(500).json({
    ok: false,
    error: "Internal server error",
  });
}

/* ======================================================
   GET /api/driver/orders
   - Returns:
     • Orders assigned to this driver
     • Orders ready for dispatch (paid + unassigned)
====================================================== */
router.get("/orders", async (req, res) => {
  const driverId = req.driverId;

  try {
    const { rows } = await pool.query(
      `
      SELECT *
      FROM orders
      WHERE
        (
          assigned_driver_id = $1
          AND status IN ('assigned', 'en_route')
        )
        OR
        (
          assigned_driver_id IS NULL
          AND payment_status = 'paid'
          AND status = 'ready_for_dispatch'
        )
      ORDER BY created_at ASC
      `,
      [driverId]
    );

    return res.json({
      ok: true,
      orders: rows,
    });
  } catch (err) {
    return serverError(res, err, "fetch orders");
  }
});

/* ======================================================
   POST /api/driver/orders/:id/accept
====================================================== */
router.post("/orders/:id/accept", async (req, res) => {
  const driverId = req.driverId;
  const orderId = req.params.id;

  try {
    const { rows } = await pool.query(
      `
      UPDATE orders
      SET
        status = 'assigned',
        assigned_driver_id = $1,
        assigned_at = NOW()
      WHERE
        id = $2
        AND status = 'ready_for_dispatch'
        AND payment_status = 'paid'
        AND assigned_driver_id IS NULL
      RETURNING *
      `,
      [driverId, orderId]
    );

    if (!rows.length) {
      return res.status(409).json({
        ok: false,
        error: "Order not available for assignment",
      });
    }

    return res.json({
      ok: true,
      order: rows[0],
    });
  } catch (err) {
    return serverError(res, err, "accept order");
  }
});

/* ======================================================
   POST /api/driver/orders/:id/start
   (Driver begins route)
====================================================== */
router.post("/orders/:id/start", async (req, res) => {
  const driverId = req.driverId;
  const orderId = req.params.id;

  try {
    const { rows } = await pool.query(
      `
      UPDATE orders
      SET
        status = 'en_route',
        pickup_at = NOW()
      WHERE
        id = $1
        AND assigned_driver_id = $2
        AND status = 'assigned'
      RETURNING *
      `,
      [orderId, driverId]
    );

    if (!rows.length) {
      return res.status(409).json({
        ok: false,
        error: "Order not assigned or invalid state",
      });
    }

    return res.json({
      ok: true,
      order: rows[0],
    });
  } catch (err) {
    return serverError(res, err, "start order");
  }
});

/* ======================================================
   POST /api/driver/orders/:id/complete
====================================================== */
router.post("/orders/:id/complete", async (req, res) => {
  const driverId = req.driverId;
  const orderId = req.params.id;

  try {
    const { rows } = await pool.query(
      `
      UPDATE orders
      SET
        status = 'completed',
        delivered_at = NOW()
      WHERE
        id = $1
        AND assigned_driver_id = $2
        AND status = 'en_route'
      RETURNING *
      `,
      [orderId, driverId]
    );

    if (!rows.length) {
      return res.status(409).json({
        ok: false,
        error: "Order not in transit or not assigned",
      });
    }

    return res.json({
      ok: true,
      order: rows[0],
    });
  } catch (err) {
    return serverError(res, err, "complete order");
  }
});

module.exports = router;