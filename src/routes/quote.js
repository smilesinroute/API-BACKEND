"use strict";

/**
 * Quote Route (Production)
 * -------------------------
 * - Plain Node router (NO Express)
 * - Uses shared distanceMatrix helper
 * - Pulls pricing from database
 */

const { getDistanceMiles } = require("../lib/distanceMatrix");

/* ======================================================
   HELPERS
====================================================== */
function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/* ======================================================
   PRICING LOOKUP
====================================================== */
async function getPricingFor(pool, region, serviceType, vehicleType) {
  const { rows } = await pool.query(
    `
    SELECT *
    FROM pricing
    WHERE region = $1
      AND service_type = $2
      AND vehicle_type = $3
    LIMIT 1
    `,
    [region, serviceType, vehicleType]
  );

  if (!rows.length) {
    throw new Error("No pricing rule found");
  }

  return rows[0];
}

/* ======================================================
   MAIN HANDLER
====================================================== */
async function handleQuote(req, res, pool, pathname, method, json) {
  if (pathname !== "/api/quote" || method !== "POST") {
    return false;
  }

  try {
    const body = await readJson(req);

    const serviceType = String(body.serviceType || "").trim();
    const region = String(body.region || "").trim();
    const vehicleType = String(body.vehicleType || "car").trim();

    const pickupAddress = String(body.pickupAddress || "").trim();
    const dropoffAddress = String(body.dropoffAddress || "").trim();

    if (!isNonEmptyString(serviceType) || !isNonEmptyString(region)) {
      return json(res, 400, {
        error: "serviceType and region are required",
      });
    }

    const pricing = await getPricingFor(
      pool,
      region,
      serviceType,
      vehicleType
    );

    let baseFee = toNumber(pricing.base_fee, 0);
    let perMile = toNumber(pricing.rate_per_mile, 0);
    let distance = 0;

    if (serviceType === "courier") {
      if (!pickupAddress || !dropoffAddress) {
        return json(res, 400, {
          error: "pickupAddress and dropoffAddress are required",
        });
      }

      distance = await getDistanceMiles(pickupAddress, dropoffAddress);
    }

    let total = baseFee + distance * perMile;

    const fragile = body.isFragile ? toNumber(pricing.fragile_fee, 0) : 0;
    const priority = body.isPriority ? toNumber(pricing.priority_fee, 0) : 0;
    const timeSensitive = body.isTimeSensitive
      ? toNumber(pricing.time_sensitive_fee, 0)
      : 0;
    const afterHours = body.isAfterHours
      ? toNumber(pricing.after_hours_fee, 0)
      : 0;

    total += fragile + priority + timeSensitive + afterHours;

    return json(res, 200, {
      ok: true,
      serviceType,
      region,
      vehicleType,
      distance,
      breakdown: {
        baseFee,
        perMile,
        fragile,
        priority,
        timeSensitive,
        afterHours,
      },
      total: Number(total.toFixed(2)),
    });
  } catch (err) {
    console.error("[QUOTE ERROR]", err);
    return json(res, 500, {
      error: err.message || "Quote calculation failed",
    });
  }
}

module.exports = { handleQuote };
