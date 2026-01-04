"use strict";

/**
 * Distance Matrix helper (server-side)
 * - Node 18+ (native fetch)
 * - Google Maps Distance Matrix API
 */
async function getDistanceMiles(pickup, delivery) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error("Missing GOOGLE_MAPS_API_KEY on server");

  if (!pickup || !delivery) {
    throw new Error("pickup and delivery addresses are required");
  }

  const url =
    "https://maps.googleapis.com/maps/api/distancematrix/json?units=imperial" +
    `&origins=${encodeURIComponent(pickup)}` +
    `&destinations=${encodeURIComponent(delivery)}` +
    `&key=${encodeURIComponent(key)}`;

  // Timeout protection (10s)
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  let res;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    throw new Error("Failed to reach Google Distance Matrix API");
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new Error(`DistanceMatrix HTTP ${res.status}`);
  }

  const data = await res.json();

  if (data.status !== "OK") {
    throw new Error(data.error_message || `DistanceMatrix status: ${data.status}`);
  }

  const element = data.rows?.[0]?.elements?.[0];
  if (!element) {
    throw new Error("No distance result returned");
  }

  if (element.status === "ZERO_RESULTS") {
    throw new Error("No drivable route between addresses");
  }

  if (element.status !== "OK") {
    throw new Error(`Route error: ${element.status}`);
  }

  const meters = element.distance?.value;
  if (typeof meters !== "number") {
    throw new Error("Distance value missing from response");
  }

  const miles = meters / 1609.34;
  return Number(miles.toFixed(2));
}

module.exports = { getDistanceMiles };
