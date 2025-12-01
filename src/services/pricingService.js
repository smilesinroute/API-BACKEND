const pool = require('../utils/db');
const axios = require('axios');

module.exports = {
  async estimate(params) {
    const {
      from,
      to,
      vehicleType,
      fragile = false,
      priority = false,
      region
    } = params;

    // 1. Get distance using Google Maps
    const googleKey = process.env.GOOGLE_MAPS_API_KEY;

    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?units=imperial&origins=${encodeURIComponent(from)}&destinations=${encodeURIComponent(to)}&key=${googleKey}`;

    const mapRes = await axios.get(url);
    const distanceText = mapRes.data.rows[0].elements[0].distance.text;
    const distanceMiles = parseFloat(distanceText.replace(/[^\d.]/g, ''));

    // 2. Look up base rate by region + vehicleType
    const rateRes = await pool.query(
      `SELECT base_fee, rate_per_mile, fragile_fee, priority_fee
       FROM pricing
       WHERE region = $1 AND vehicle_type = $2`,
      [region, vehicleType]
    );

    if (rateRes.rows.length === 0) {
      throw new Error(`No pricing found for region=${region}, vehicle=${vehicleType}`);
    }

    const rate = rateRes.rows[0];

    // 3. Calculate total
    let total =
      rate.base_fee +
      distanceMiles * rate.rate_per_mile +
      (fragile ? rate.fragile_fee : 0) +
      (priority ? rate.priority_fee : 0);

    total = Number(total.toFixed(2));

    return {
      from,
      to,
      vehicleType,
      fragile,
      priority,
      region,
      distanceMiles,
      total
    };
  }
};

