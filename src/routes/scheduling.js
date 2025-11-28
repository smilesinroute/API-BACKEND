// scheduling.js
// Express router for scheduling related endpoints
const express = require('express');
const router = express.Router();

// Example route
router.get('/', (req, res) => {
  res.json({ message: 'Scheduling route' });
});

module.exports = router;
