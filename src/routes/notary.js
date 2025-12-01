// src/routes/notary.js
const express = require('express');
const router = express.Router();
const pool = require('../utils/db');

// GET /api/notary - get all active notary documents
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * 
      FROM notary_documents
      WHERE active = true
      ORDER BY category, document_name
    `);
    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error fetching notary documents:', err);
    res.status(500).json({ error: 'Failed to fetch notary documents', details: err.message });
  }
});

// GET /api/notary/:id - get single notary document by ID
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      'SELECT * FROM notary_documents WHERE document_id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Notary document not found' });
    }

    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching notary document:', err);
    res.status(500).json({ error: 'Failed to fetch notary document', details: err.message });
  }
});

module.exports = router;

