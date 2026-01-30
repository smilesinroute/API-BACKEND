"use strict";

const express = require("express");
const router = express.Router();
const pool = require("../utils/db");

/* ======================================================
   GET /orders — list all orders
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
   GET /orders/:id — single order
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
    return res.status(400).json({ error: "customer_email is required" });
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
        status
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'confirmed_pending_payment')
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

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("[ORDERS] create:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ======================================================
   PUT /orders/:id — update status
====================================================== */
router.put("/:id", async (req, res) => {
  const { status } = req.body || {};
  if (!status) {
    return res.status(400).json({ error: "status is required" });
  }

  try {
    const { rows } = await pool.query(
      `
      UPDATE orders
      SET status = $1
      WHERE id = $2
      RETURNING *
      `,
      [status, req.params.id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Order not found" });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("[ORDERS] update:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ======================================================
   DELETE /orders/:id
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

module.exports = router;
