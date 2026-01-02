/**
 * Distance Matrix helper (server-side)
 * Uses Node's built-in fetch (Node 18+)
 */
async function getDistanceMiles(pickup, delivery) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error("Missing GOOGLE_MAPS_API_KEY on server");

  const url =
    "https://maps.googleapis.com/maps/api/distancematrix/json?units=imperial" +
    `&origins=${encodeURIComponent(pickup)}` +
    `&destinations=${encodeURIComponent(delivery)}` +
    `&key=${encodeURIComponent(key)}`;

  const res = await fetch(url);
  const data = await res.json();

  if (data.status !== "OK") {
    throw new Error(data.error_message || `DistanceMatrix status: ${data.status}`);
  }

  const el = data.rows?.[0]?.elements?.[0];
  if (!el || el.status !== "OK") {
    throw new Error(`Invalid route: ${el?.status || "UNKNOWN"}`);
  }

  const meters = el.distance?.value;
  if (typeof meters !== "number") throw new Error("No distance value returned");

  const miles = meters / 1609.34;
  return Number(miles.toFixed(2));
}

module.exports = { getDistanceMiles };
