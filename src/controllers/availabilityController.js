"use strict";

/**
 * Canonical Availability Controller
 * ---------------------------------
 * Supports:
 *   GET /api/schedule?date=YYYY-MM-DD
 *   GET /api/v1/availability?date=YYYY-MM-DD
 *
 * Always returns:
 *   { availableSlots: ["09:00", "10:00", ...] }
 */

const url = require("url");

/* ======================================================
   STATIC TIME SLOT GENERATOR
   (Safe production default)
====================================================== */
function generateSlots() {
  return [
    "08:00",
    "09:00",
    "10:00",
    "11:00",
    "12:00",
    "13:00",
    "14:00",
    "15:00",
    "16:00",
    "17:00",
  ];
}

async function handleAvailability(req, res, pool, pathname, method, json) {
  if (method !== "GET") return false;

  /* ======================================================
     SUPPORT BOTH ROUTES
  ====================================================== */
  if (
    pathname !== "/api/schedule" &&
    pathname !== "/api/v1/availability"
  ) {
    return false;
  }

  try {
    const { query } = url.parse(req.url, true);
    const date = String(query.date || "");

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return json(res, 400, {
        error: "Invalid or missing date (YYYY-MM-DD required)",
      });
    }

    // TODO: Replace with real driver availability logic
    const availableSlots = generateSlots();

    return json(res, 200, { availableSlots });
  } catch (err) {
    console.error("[AVAILABILITY ERROR]", err);
    return json(res, 500, { error: "Availability error" });
  }
}

module.exports = { handleAvailability };
