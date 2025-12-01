// src/routes/vehicles.js
const express = require('express');
const router = express.Router();
const pool = require('../utils/db'); // PostgreSQL connection

// GET /api/vehicles - Get all active vehicles
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * 
      FROM vehicles 
      WHERE active = true 
      ORDER BY vehicle_type
    `);

    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error fetching vehicles:', err);
    res.status(500).json({
      error: 'Failed to fetch vehicles',
      details: err.message
    });
  }
});

module.exports = router;
