
"use strict";

const express = require("express");
const router = express.Router();
const pool = require("../utils/db");

/* ======================================================
   DRIVER AUTH MIDDLEWARE
   - Replace with real JWT/session verification later
   - For now: token value = driver ID
====================================================== */
function requireDriver(req, res, next) {
  const header = String(req.headers.authorization || "");

  if (!header.toLowerCase().startsWith("bearer ")) {
    return res.status(401).json({
      error: "Missing Authorization token",
    });
  }

  const token = header.replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    return res.status(401).json({
      error: "Invalid Authorization token",
    });
  }

  // TODO: replace with real token decoding
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
    error: "Internal server error",
  });
}

/* ======================================================
   GET /api/driver/orders
   - Returns:
     • paid orders available for assignment
     • orders already assigned to driver
====================================================== */
router.get("/orders", async (req, res) => {
  const driverId = req.driverId;

  try {
    const { rows } = await pool.query(
      `
      SELECT *
      FROM orders
      WHERE
        status = 'paid'
        OR assigned_driver_id = $1
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
   - Driver accepts a paid order
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
        AND status = 'paid'
      RETURNING *
      `,
      [driverId, orderId]
    );

    if (!rows.length) {
      return res.status(409).json({
        error: "Order not available for assignment",
      });
    }

    return res.json(rows[0]);
  } catch (err) {
    return serverError(res, err, "accept order");
  }
});

/* ======================================================
   POST /api/driver/orders/:id/pickup
   - Driver confirms pickup
====================================================== */
router.post("/orders/:id/pickup", async (req, res) => {
  const driverId = req.driverId;
  const orderId = req.params.id;

  try {
    const { rows } = await pool.query(
      `
      UPDATE orders
      SET
        status = 'in_progress',
        picked_up_at = NOW()
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
        error: "Order not assigned or invalid state",
      });
    }

    return res.json(rows[0]);
  } catch (err) {
    return serverError(res, err, "pickup");
  }
});

/* ======================================================
   POST /api/driver/orders/:id/delivered
   - Driver confirms delivery
====================================================== */
router.post("/orders/:id/delivered", async (req, res) => {
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
        AND status = 'in_progress'
      RETURNING *
      `,
      [orderId, driverId]
    );

    if (!rows.length) {
      return res.status(409).json({
        error: "Order not in progress or not assigned",
      });
    }

    return res.json(rows[0]);
  } catch (err) {
    return serverError(res, err, "delivered");
  }
});

module.exports = router;
