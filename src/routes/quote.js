// src/routes/quote.js
const express = require('express');
const router = express.Router();
const pool = require('../utils/db');
const axios = require('axios');

// Helper: calculate distance using Google Maps API
async function getDistanceMiles(origin, destination) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?units=imperial&origins=${encodeURIComponent(
    origin
  )}&destinations=${encodeURIComponent(destination)}&key=${apiKey}`;

  const response = await axios.get(url);

  if (!response.data.rows?.[0]?.elements?.[0]?.distance) {
    throw new Error("Unable to calculate distance");
  }

  const distanceText = response.data.rows[0].elements[0].distance.text; // e.g. "12.3 mi"
  return parseFloat(distanceText.replace(" mi", ""));
}

// Helper: Fetch pricing rules from database
async function getPricingFor(region, serviceType, vehicleType) {
  const query = `
    SELECT *
    FROM pricing
    WHERE region = $1
      AND service_type = $2
      AND vehicle_type = $3
    LIMIT 1;
  `;

  const { rows } = await pool.query(query, [region, serviceType, vehicleType]);
  if (rows.length === 0) throw new Error("No pricing rule found");

  return rows[0];
}

// Main Quote Endpoint
router.post('/quote', async (req, res) => {
  try {
    const {
      serviceType,        // courier | notary | ron
      region,             // OR | TX | CA | etc.
      vehicleType,        // car | suv | van
      pickupAddress,
      dropoffAddress,
      isFragile,
      isPriority,
      isTimeSensitive,
      isAfterHours
    } = req.body;

    if (!serviceType || !region) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Pull pricing rules
    const pricing = await getPricingFor(region, serviceType, vehicleType);

    let baseFee = Number(pricing.base_fee);
    let perMile = Number(pricing.rate_per_mile);
    let distance = 0;

    // Only courier requires distance
    if (serviceType === "courier") {
      distance = await getDistanceMiles(pickupAddress, dropoffAddress);
    }

    let total = baseFee + distance * perMile;

    // Add-ons
    if (isFragile) total += pricing.fragile_fee || 0;
    if (isPriority) total += pricing.priority_fee || 0;
    if (isTimeSensitive) total += pricing.time_sensitive_fee || 0;
    if (isAfterHours) total += pricing.after_hours_fee || 0;

    return res.json({
      success: true,
      serviceType,
      region,
      vehicleType,
      distance,
      breakdown: {
        baseFee,
        perMile,
        fragile: isFragile ? pricing.fragile_fee : 0,
        priority: isPriority ? pricing.priority_fee : 0,
        timeSensitive: isTimeSensitive ? pricing.time_sensitive_fee : 0,
        afterHours: isAfterHours ? pricing.after_hours_fee : 0
      },
      total
    });

  } catch (err) {
    console.error("QUOTE ERROR:", err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;

