// apps/api/src/routes/pricing.js
const express = require('express');
const router = express.Router();
const pricingService = require('../services/pricingService');

// POST /api/pricing/estimate
router.post('/estimate', async (req, res, next) => {
  try {
    const params = req.body; // { from, to, vehicleType, fragile, priority, region }
    const estimate = await pricingService.estimate(params);
    res.json({ estimate });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

