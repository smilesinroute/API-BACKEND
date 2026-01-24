"use strict";

/* ======================================================
   DISTANCE SERVICE — CANONICAL
   API-only responsibility
====================================================== */

/**
 * Returns driving distance in miles between two addresses.
 * Replace implementation with Google Maps / Mapbox later.
 */
async function getDrivingDistanceMiles(pickupAddress, deliveryAddress) {
  if (!pickupAddress || !deliveryAddress) {
    throw new Error("Missing pickup or delivery address");
  }

  // TEMP PLACEHOLDER
  // TODO: replace with real distance provider
  const distanceMiles = 12.4;

  if (!distanceMiles || distanceMiles <= 0) {
    throw new Error("Distance lookup failed");
  }

  return distanceMiles;
}

module.exports = { getDrivingDistanceMiles };
