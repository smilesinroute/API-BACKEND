// apps/api/src/routes/admin.js
const express = require('express');
const router = express.Router();

// Simple admin stub - expand with auth & useful endpoints
router.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// Example: list recent bookings (implement DB query in services later)
router.get('/recent-bookings', async (req, res) => {
  // Placeholder - replace with real DB query
  res.json({ bookings: [], note: 'Implement DB query in bookingService' });
});

module.exports = router;
