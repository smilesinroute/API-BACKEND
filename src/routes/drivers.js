// src/routes/drivers.js
const express = require('express');
const router = express.Router();
const pool = require('../utils/db');

/**
 * GET /api/drivers
 * Returns all active drivers
 */
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT driver_id, first_name, last_name, phone, email, status, vehicle_id
      FROM drivers
      WHERE active = true
      ORDER BY first_name
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching drivers:", err);
    res.status(500).json({ error: "Failed to fetch drivers" });
  }
});


/**
 * POST /api/drivers/login
 * Driver login for the mobile app/portal
 */
router.post('/login', async (req, res) => {
  const { email, pin } = req.body; // Drivers use a 4–6 digit pin

  try {
    const result = await pool.query(`
      SELECT driver_id, first_name, last_name, email, status, vehicle_id
      FROM drivers
      WHERE email = $1 AND pin = $2 AND active = true
    `, [email, pin]);

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid email or PIN" });
    }

    res.json({
      message: "Login successful",
      driver: result.rows[0]
    });
  } catch (err) {
    console.error("Driver login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});


/**
 * POST /api/drivers/status
 * Update driver availability (online/offline)
 * Example body: { driverId, status }
 */
router.post('/status', async (req, res) => {
  const { driverId, status } = req.body;

  try {
    const result = await pool.query(`
      UPDATE drivers
      SET status = $1
      WHERE driver_id = $2
      RETURNING driver_id, status
    `, [status, driverId]);

    res.json({
      message: "Status updated",
      driver: result.rows[0]
    });
  } catch (err) {
    console.error("Error updating driver status:", err);
    res.status(500).json({ error: "Failed to update status" });
  }
});


/**
 * POST /api/drivers/location
 * Update live driver GPS location
 * Example body: { driverId, lat, lng }
 */
router.post('/location', async (req, res) => {
  const { driverId, lat, lng } = req.body;

  try {
    await pool.query(`
      INSERT INTO driver_locations (driver_id, lat, lng, timestamp)
      VALUES ($1, $2, $3, NOW())
    `, [driverId, lat, lng]);

    res.json({ success: true });
  } catch (err) {
    console.error("Error saving location:", err);
    res.status(500).json({ error: "Failed to save location" });
  }
});


/**
 * GET /api/drivers/:id/assignments
 * Get active orders assigned to a driver
 */
router.get('/:id/assignments', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(`
      SELECT o.*, c.first_name, c.last_name, c.phone, c.email
      FROM orders o
      JOIN customers c ON o.customer_id = c.customer_id
      WHERE o.driver_id = $1
      AND o.status NOT IN ('completed', 'cancelled')
      ORDER BY o.created_at DESC
    `, [id]);

    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching assignments:", err);
    res.status(500).json({ error: "Failed to fetch assignments" });
  }
});


/**
 * POST /api/drivers/assignment/update
 * Driver updates order status
 * { driverId, orderId, status }
 */
router.post('/assignment/update', async (req, res) => {
  const { driverId, orderId, status } = req.body;

  try {
    const result = await pool.query(`
      UPDATE orders
      SET status = $1
      WHERE order_id = $2 AND driver_id = $3
      RETURNING *
    `, [status, orderId, driverId]);

    res.json({
      message: "Order status updated",
      order: result.rows[0]
    });
  } catch (err) {
    console.error("Error updating order status:", err);
    res.status(500).json({ error: "Failed to update order" });
  }
});

module.exports = router;
