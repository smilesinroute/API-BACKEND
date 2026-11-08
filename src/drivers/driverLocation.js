"use strict";

const { json } = require("../lib/driverAuth");
const { verifyDriverAccess } = require("../lib/driverAccess");

const maxBodyBytes = 1024;

async function readLocation(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > maxBodyBytes) return null;
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

async function handleDriverLocation(req, res, pool) {
  res.setHeader("Cache-Control", "no-store");
  const access = await verifyDriverAccess(req);
  if (!access.email) return json(res, access.status, { error: access.error });
  if (req.headers["content-type"] !== "application/json") {
    return json(res, 415, { error: "Send a JSON location update." });
  }

  const body = await readLocation(req);
  const { action, eventAt, latitude, longitude, accuracy } = body ?? {};
  const now = Date.now();
  if (!["share", "stop"].includes(action) || !Number.isSafeInteger(eventAt) ||
      eventAt < now - 120000 || eventAt > now + 30000) {
    return json(res, 400, { error: "Invalid location update. Check your device clock and try again." });
  }

  const sharing = action === "share";
  if (sharing && (
    !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
    !Number.isFinite(longitude) || longitude < -180 || longitude > 180 ||
    !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100000
  )) {
    return json(res, 400, { error: "Send a valid location and accuracy." });
  }

  const { rows } = await pool.query(
    `WITH matching AS MATERIALIZED (
       SELECT id, company_id, active, status
       FROM public.drivers WHERE lower(email) = $1 LIMIT 2 FOR SHARE
     ), active_driver AS (
       SELECT id FROM matching
       WHERE company_id = 1 AND active IS TRUE AND status IS DISTINCT FROM 'inactive'
         AND (SELECT count(*) FROM matching) = 1
     ), saved AS (
       INSERT INTO dispatch_private.driver_live_locations AS stored
         (driver_id, event_at, latitude, longitude, accuracy_m)
       SELECT id, $2, $3, $4, $5 FROM active_driver
       ON CONFLICT (driver_id) DO UPDATE SET
         event_at = EXCLUDED.event_at, latitude = EXCLUDED.latitude,
         longitude = EXCLUDED.longitude, accuracy_m = EXCLUDED.accuracy_m
       WHERE EXCLUDED.event_at > stored.event_at
         OR (EXCLUDED.event_at = stored.event_at AND EXCLUDED.latitude IS NULL)
       RETURNING driver_id
     )
     SELECT EXISTS (SELECT 1 FROM active_driver) AS allowed,
            EXISTS (SELECT 1 FROM saved) AS applied`,
    [access.email, new Date(eventAt), sharing ? latitude : null, sharing ? longitude : null, sharing ? accuracy : null]
  );
  if (!rows[0].allowed) {
    return json(res, 403, { error: "This Cloudflare account is not registered as an active driver." });
  }
  if (!rows[0].applied && sharing) {
    return json(res, 409, { error: "A newer location update is already on file." });
  }
  return json(res, 200, { ok: true });
}

module.exports = { handleDriverLocation };
