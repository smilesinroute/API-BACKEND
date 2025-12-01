// src/routes/courier.js
const express = require('express');
const router = express.Router();
const pool = require('../utils/db');

// POST /api/courier/quote
router.post('/quote', async (req, res) => {
  try {
    const { vehicle_type, distance_miles, priority, num_packages } = req.body;
    const vehicle = await pool.query(
      'SELECT base_rate, cost_per_mile FROM vehicles WHERE vehicle_type = $1',
      [vehicle_type]
    );

    if (!vehicle.rows.length) return res.status(400).json({ error: 'Invalid vehicle type' });

    let base = parseFloat(vehicle.rows[0].base_rate);
    let distanceCost = parseFloat(distance_miles) * parseFloat(vehicle.rows[0].cost_per_mile);
    let priorityFee = priority ? 15 : 0;
    let discount = num_packages >= 5 ? 0.1 * (base + distanceCost) : 0;
    const total = base + distanceCost + priorityFee - discount;

    res.json({ base, distanceCost, priorityFee, discount, total, pricing_type: 'standard' });
  } catch (err) {
    console.error('Error calculating courier quote:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
