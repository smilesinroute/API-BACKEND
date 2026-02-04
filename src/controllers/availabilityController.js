"use strict";

/**
 * Canonical Availability Controller (v1)
 * -------------------------------------
 * - Platform-level endpoint
 * - Role-agnostic
 * - ALWAYS returns 200 with an array
 */

async function handleAvailability(req, res, pool, pathname, method, json) {
  if (method !== "GET") return false;
  if (pathname !== "/api/v1/availability") return false;

  try {
    // Placeholder: wire existing scheduling logic later
    return json(res, 200, []);
  } catch (err) {
    console.error("[AVAILABILITY]", err);
    return json(res, 500, { error: "Availability error" });
  }
}

module.exports = { handleAvailability };
