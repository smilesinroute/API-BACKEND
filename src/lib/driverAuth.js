"use strict";

const crypto = require("crypto");

function json(res, code, payload) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function getBearerToken(req) {
  const auth = String(req.headers.authorization || "");
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function newToken() {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Create a driver session
 * Reads selfie status from drivers table
 */
async function createDriverSession(pool, driverId) {
  // Get real driver selfie status
  const { rows } = await pool.query(
    `
    SELECT selfie_verified
    FROM drivers
    WHERE id = $1
    LIMIT 1
    `,
    [driverId]
  );

  if (!rows.length) {
    throw new Error("Driver not found");
  }

  const driver = rows[0];
  const token = newToken();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await pool.query(
    `
    INSERT INTO driver_sessions (
      driver_id,
      token,
      selfie_completed,
      expires_at
    )
    VALUES ($1, $2, $3, $4)
    `,
    [driverId, token, !!driver.selfie_verified, expiresAt]
  );

  return token;
}

/**
 * Require valid driver session
 */
async function requireDriver(pool, req, { requireSelfie = true } = {}) {
  const token = getBearerToken(req);
  if (!token) throw new Error("Missing Authorization token");

  const { rows } = await pool.query(
    `
    SELECT
      ds.driver_id,
      ds.selfie_completed,
      ds.expires_at,
      d.selfie_verified,
      d.active,
      d.status
    FROM driver_sessions ds
    JOIN drivers d ON d.id = ds.driver_id
    WHERE ds.token = $1
    LIMIT 1
    `,
    [token]
  );

  if (!rows.length) throw new Error("Invalid driver token");

  const session = rows[0];

  if (new Date(session.expires_at) < new Date()) {
    throw new Error("Driver session expired");
  }

  if (!session.active || session.status === "inactive") {
    throw new Error("Driver inactive");
  }

  // Use actual driver selfie status
  if (requireSelfie && !session.selfie_verified) {
    throw new Error("Selfie required");
  }

  return {
    driver_id: session.driver_id,
    selfie_completed: session.selfie_completed,
  };
}

module.exports = {
  json,
  createDriverSession,
  requireDriver,
};
