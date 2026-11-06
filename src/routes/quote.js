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

function pricingNumber(pricing, field) {
  const value = pricing[field];
  const n = Number(value);
  if ((typeof value !== "number" && typeof value !== "string") ||
      (typeof value === "string" && !value.trim()) ||
      !Number.isFinite(n) || n < 0) {
    throw new Error(`Quote pricing is not configured: ${field}`);
  }
  return n;
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
  // The customer portal calls the approved Oregon Standard service "Sedan".
  // Keep the amounts in pricing_config so edits apply to the next quote.
  const pricingVehicle = serviceType === "courier" && region === "oregon" &&
    vehicleType === "sedan" ? "standard" : vehicleType;

  const { rows } = await pool.query(
    `
    SELECT *
    FROM public.pricing_config
    WHERE region = $1
      AND service_type = $2
      AND vehicle_type = $3
      AND active = true
    LIMIT 2
    `,
    [region, serviceType, pricingVehicle]
  );

  if (!rows.length) {
    throw new Error("No active pricing rule found for this region and vehicle");
  }

  if (rows.length !== 1) {
    throw new Error("Multiple active pricing rules found for this region and vehicle");
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

    if (serviceType === "courier" && (!pickupAddress || !dropoffAddress)) {
      return json(res, 400, {
        error: "pickupAddress and dropoffAddress are required",
      });
    }

    const pricing = await getPricingFor(
      pool,
      region,
      serviceType,
      vehicleType
    );

    const baseFee = pricingNumber(pricing, "base_rate");
    const perMile = pricingNumber(pricing, "per_mile_rate");
    const fragile = body.fragile ? pricingNumber(pricing, "fragile_fee") : 0;
    const priority = body.priority ? pricingNumber(pricing, "priority_fee") : 0;
    const timeSensitive = body.timeSensitive
      ? pricingNumber(pricing, "time_sensitive_fee") : 0;
    const afterHours = body.afterHours
      ? pricingNumber(pricing, "after_hours_fee") : 0;
    let distance = 0;

    /* ================= COURIER DISTANCE ================= */

    if (serviceType === "courier") {
      distance = await getDistanceMiles(pickupAddress, dropoffAddress);
    }

    /* ================= BASE CALCULATION ================= */

    let total = baseFee + distance * perMile;

    /* ================= ADD-ONS ================= */

    total += fragile + priority + timeSensitive + afterHours;

    /* ================= RESPONSE ================= */

    return json(res, 200, {
      ok: true,
      serviceType,
      region,
      vehicleType,
      distance,
      breakdown: {
        baseFee,
        perMile,
        mileageCost: Number((distance * perMile).toFixed(2)),
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
