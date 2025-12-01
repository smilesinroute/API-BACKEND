// src/routes/admin.js
const express = require('express');
const router = express.Router();
const pool = require('../utils/db');

// GET /api/admin/orders
router.get('/orders', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('Admin fetch orders error:', err);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// GET /api/admin/customers
router.get('/customers', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM customers ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('Admin fetch customers error:', err);
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
});

module.exports = router;

