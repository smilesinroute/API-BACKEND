"use strict";

// src/routes/orders.js
const express = require("express");
const router = express.Router();

const pool = require("../utils/db");

/* ======================================================
   Helpers
====================================================== */

function asTrimmedString(v) {
  return String(v ?? "").trim();
}

function asNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asBool(v, fallback = false) {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.toLowerCase() === "true";
  if (typeof v === "number") return v === 1;
  return fallback;
}

/**
 * Normalize DB row(s) into a stable API shape:
 * - id always present
 * - customer_email always present
 * - total_amount provided (alias of total_cost)
 */
function normalizeOrderRow(row) {
  if (!row) return row;

  return {
    ...row,

    // Canonical fields used by admin/dashboard
    id: row.order_id ?? row.id,

    // If your admin code expects customer_email, provide it
    customer_email: row.customer_email ?? row.email ?? null,

    // Provide total_amount alias (admin expects total_amount)
    total_amount:
      row.total_amount != null
        ? row.total_amount
        : row.total_cost != null
        ? row.total_cost
        : null,
  };
}

/* ======================================================
   SQL (shared)
====================================================== */

const ORDER_SELECT = `
  SELECT
    o.*,

    -- Customer fields (authoritative source of email)
    c.first_name,
    c.last_name,
    c.email AS customer_email,

    -- Optional enrichments
    s.service_name,
    v.vehicle_type,
    nd.document_name

  FROM orders o
  JOIN customers c ON o.customer_id = c.customer_id
  JOIN services s ON o.service_id = s.service_id
  LEFT JOIN vehicles v ON o.vehicle_id = v.vehicle_id
  LEFT JOIN notary_documents nd ON o.document_id = nd.document_id
`;

/* ======================================================
   ROUTES
====================================================== */

/**
 * GET /orders
 * Returns all orders with full detail payload
 */
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(`
      ${ORDER_SELECT}
      ORDER BY o.created_at DESC
    `);

    res.json(result.rows.map(normalizeOrderRow));
  } catch (err) {
    console.error("[ORDERS] Error fetching orders:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /orders/:id
 * Returns one order with full detail payload
 */
router.get("/:id", async (req, res) => {
  const id = asTrimmedString(req.params.id);

  try {
    const result = await pool.query(
      `
      ${ORDER_SELECT}
      WHERE o.order_id = $1
      LIMIT 1
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Order not found" });
    }

    res.json(normalizeOrderRow(result.rows[0]));
  } catch (err) {
    console.error("[ORDERS] Error fetching order:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /orders
 * Creates customer (if needed) + creates order.
 *
 * IMPORTANT:
 * - Email is stored on customers table (NOT orders)
 * - New orders start in confirmed_pending_payment
 */
router.post("/", async (req, res) => {
  const body = req.body || {};

  // Minimal required fields (adjust as needed)
  const email = asTrimmedString(body.email).toLowerCase();
  const serviceId = asTrimmedString(body.service_id);
  const pickupAddress = asTrimmedString(body.pickup_address);
  const deliveryAddress = asTrimmedString(body.delivery_address);

  if (!email) return res.status(400).json({ error: "email is required" });
  if (!serviceId) return res.status(400).json({ error: "service_id is required" });

  // You may allow other service types, so only require pickup/delivery if you want:
  // If you ALWAYS need both, keep these validations on:
  if (!pickupAddress) return res.status(400).json({ error: "pickup_address is required" });
  if (!deliveryAddress) return res.status(400).json({ error: "delivery_address is required" });

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /* ---------- Ensure customer exists ---------- */
    let customerId;

    const existingCustomer = await client.query(
      `SELECT customer_id FROM customers WHERE lower(email) = lower($1) LIMIT 1`,
      [email]
    );

    if (existingCustomer.rows.length > 0) {
      customerId = existingCustomer.rows[0].customer_id;
    } else {
      const customerResult = await client.query(
        `
        INSERT INTO customers (
          first_name,
          last_name,
          email,
          phone,
          street_address,
          city,
          state,
          zip_code
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING customer_id
        `,
        [
          asTrimmedString(body.first_name) || null,
          asTrimmedString(body.last_name) || null,
          email,
          asTrimmedString(body.phone) || null,
          asTrimmedString(body.street_address) || null,
          asTrimmedString(body.city) || null,
          asTrimmedString(body.state) || null,
          asTrimmedString(body.zip_code) || null,
        ]
      );

      customerId = customerResult.rows[0].customer_id;
    }

    /* ---------- Insert order ---------- */
    const insertResult = await client.query(
      `
      INSERT INTO orders (
        customer_id,
        service_id,
        vehicle_id,
        document_id,

        pickup_address,
        delivery_address,
        appointment_address,

        distance_miles,
        priority,
        num_packages,
        num_signatures,

        batch_id,
        contract_id,

        base_cost,
        distance_cost,
        priority_fee,
        signature_fee,
        travel_fee,
        discount,

        total_cost,
        status
      )
      VALUES (
        $1,$2,$3,$4,
        $5,$6,$7,
        $8,$9,$10,$11,
        $12,$13,
        $14,$15,$16,$17,$18,$19,
        $20,$21
      )
      RETURNING *
      `,
      [
        customerId,
        serviceId,
        body.vehicle_id || null,
        body.document_id || null,

        pickupAddress || null,
        deliveryAddress || null,
        asTrimmedString(body.appointment_address) || null,

        asNumber(body.distance_miles, 0),
        asBool(body.priority, false),
        asNumber(body.num_packages, 1),
        asNumber(body.num_signatures, 1),

        body.batch_id || null,
        body.contract_id || null,

        asNumber(body.base_cost, 0),
        asNumber(body.distance_cost, 0),
        asNumber(body.priority_fee, 0),
        asNumber(body.signature_fee, 0),
        asNumber(body.travel_fee, 0),
        asNumber(body.discount, 0),

        asNumber(body.total_cost, 0),

        // ✅ IMPORTANT: align with admin lifecycle
        "confirmed_pending_payment",
      ]
    );

    await client.query("COMMIT");

    // Return enriched order payload (join customer/service/etc)
    const orderId = insertResult.rows[0].order_id;
    const full = await pool.query(
      `
      ${ORDER_SELECT}
      WHERE o.order_id = $1
      LIMIT 1
      `,
      [orderId]
    );

    res.status(201).json(normalizeOrderRow(full.rows[0]));
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}

    console.error("[ORDERS] Error creating order:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
});

/**
 * PUT /orders/:id
 * Updates order status (admin/ops use)
 */
router.put("/:id", async (req, res) => {
  const id = asTrimmedString(req.params.id);
  const status = asTrimmedString(req.body?.status);

  if (!status) return res.status(400).json({ error: "status is required" });

  try {
    const completedAt = status === "completed" ? new Date() : null;

    const result = await pool.query(
      `
      UPDATE orders
      SET status = $1,
          completed_at = $2
      WHERE order_id = $3
      RETURNING *
      `,
      [status, completedAt, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Order not found" });
    }

    // Return enriched payload for UI
    const full = await pool.query(
      `
      ${ORDER_SELECT}
      WHERE o.order_id = $1
      LIMIT 1
      `,
      [id]
    );

    res.json(normalizeOrderRow(full.rows[0]));
  } catch (err) {
    console.error("[ORDERS] Error updating order:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * DELETE /orders/:id
 * Deletes an order (admin only)
 */
router.delete("/:id", async (req, res) => {
  const id = asTrimmedString(req.params.id);

  try {
    const result = await pool.query(
      `DELETE FROM orders WHERE order_id = $1 RETURNING *`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Order not found" });
    }

    res.json({
      message: "Order deleted successfully",
      order: normalizeOrderRow(result.rows[0]),
    });
  } catch (err) {
    console.error("[ORDERS] Error deleting order:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
