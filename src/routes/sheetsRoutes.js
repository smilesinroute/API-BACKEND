const express = require('express');
const router = express.Router();
const googleSheets = require('../utils/googleSheets'); // your helper

// Example endpoint
router.get('/test', async (req, res) => {
  res.json({ message: 'Sheets route working!' });
});

// Add other Sheets routes here using googleSheets

module.exports = router;
