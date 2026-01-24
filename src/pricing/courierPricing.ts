"use strict";

/* ======================================================
   COURIER PRICING — CANONICAL (API ONLY)
====================================================== */

const BASE_RATE = 25.0;
const PER_MILE_RATE = 2.25;

const SURCHARGES = {
  fragile: 10.0,
  priority: 20.0,
  timeSensitive: 15.0,
};

function calculateCourierPricing(distanceMiles, options = {}) {
  const miles = Number(distanceMiles);
  if (!Number.isFinite(miles) || miles <= 0) {
    throw new Error("Invalid distance for pricing");
  }

  const roundedMiles = Math.ceil(miles);
  const mileageCost = roundedMiles * PER_MILE_RATE;

  const breakdown = {
    fragile: options.fragile ? SURCHARGES.fragile : 0,
    priority: options.priority ? SURCHARGES.priority : 0,
    timeSensitive: options.timeSensitive ? SURCHARGES.timeSensitive : 0,
  };

  const total =
    BASE_RATE +
    mileageCost +
    breakdown.fragile +
    breakdown.priority +
    breakdown.timeSensitive;

  return {
    base: BASE_RATE,
    mileageCost: Number(mileageCost.toFixed(2)),
    breakdown,
    total: Number(total.toFixed(2)),
    roundedMiles,
    perMileRate: PER_MILE_RATE,
  };
}

module.exports = { calculateCourierPricing };
