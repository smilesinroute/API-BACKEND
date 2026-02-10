"use strict";

const express = require("express");
const router = express.Router();
const pool = require("../utils/db");

/* ======================================================
   ORDER STATUS RULES (ADMIN ONLY)
====================================================== */

const ALLOWED_STATUSES = [
  "confirmed_pending_payment",
  "paid",
  "assigned",
  "completed",
  "canceled",
];

const ALLOWED_TRANSITIONS = {
  confirmed_pending_payment: ["paid", "canceled"],
  paid: ["assigned", "canceled"],
  assigned: ["completed", "canceled"],
  completed: [],
  canceled: [],
};

/* ======================================================
   GET /orders — list all orders (ADMIN)
====================================================== */
router.get("/", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT *
      FROM orders
      ORDER BY created_at DESC
    `);

    res.json(rows);
  } catch (err) {
    console.error("[ORDERS] fetch all:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ======================================================
   GET /orders/:id — single order (ADMIN)
====================================================== */
router.get("/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM orders WHERE id = $1 LIMIT 1`,
      [req.params.id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Order not found" });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("[ORDERS] fetch one:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ======================================================
   POST /orders — create order
====================================================== */
router.post("/", async (req, res) => {
  const {
    customer_id = null,
    customer_email,
    pickup_address,
    delivery_address,
    scheduled_date,
    scheduled_time,
    distance_miles = 0,
    total_amount = 0,
  } = req.body || {};

  if (!customer_email) {
    return res.status(400).json({
      error: "customer_email is required",
    });
  }

  if (!pickup_address || !delivery_address) {
    return res.status(400).json({
      error: "pickup_address and delivery_address are required",
    });
  }

  try {
    const { rows } = await pool.query(
      `
      INSERT INTO orders (
        customer_id,
        customer_email,
        pickup_address,
        delivery_address,
        scheduled_date,
        scheduled_time,
        distance_miles,
        total_amount,
        status,
        payment_status
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'confirmed_pending_payment','unpaid')
      RETURNING *
      `,
      [
        customer_id,
        customer_email,
        pickup_address,
        delivery_address,
        scheduled_date,
        scheduled_time,
        distance_miles,
        total_amount,
      ]
    );

    console.log("[ORDERS] created:", rows[0].id);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("[ORDERS] create:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ======================================================
   PUT /orders/:id — update status (ADMIN ONLY)
====================================================== */
router.put("/:id", async (req, res) => {
  const { status: nextStatus } = req.body || {};

  if (!nextStatus) {
    return res.status(400).json({ error: "status is required" });
  }

  if (!ALLOWED_STATUSES.includes(nextStatus)) {
    return res.status(400).json({ error: "Invalid status value" });
  }

  try {
    const current = await pool.query(
      `SELECT status FROM orders WHERE id = $1`,
      [req.params.id]
    );

    if (!current.rows.length) {
      return res.status(404).json({ error: "Order not found" });
    }

    const currentStatus = current.rows[0].status;
    const allowedNext = ALLOWED_TRANSITIONS[currentStatus] || [];

    if (!allowedNext.includes(nextStatus)) {
      return res.status(400).json({
        error: `Invalid status transition from '${currentStatus}' to '${nextStatus}'`,
      });
    }

    const updated = await pool.query(
      `
      UPDATE orders
      SET status = $1
      WHERE id = $2
      RETURNING *
      `,
      [nextStatus, req.params.id]
    );

    res.json(updated.rows[0]);
  } catch (err) {
    console.error("[ORDERS] update status:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ======================================================
   DELETE /orders/:id — hard delete (ADMIN ONLY)
====================================================== */
router.delete("/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM orders WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Order not found" });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("[ORDERS] delete:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ======================================================
   GET /driver/orders — orders available to drivers
====================================================== */
router.get("/driver/orders", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT *
      FROM orders
      WHERE status = 'paid'
      ORDER BY created_at ASC
    `);

    res.json({
      ok: true,
      orders: rows,
    });
  } catch (err) {
    console.error("[DRIVER ORDERS] fetch:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
