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
 * TABLE: driver_sessions
 * columns:
 * - id
 * - driver_id
 * - token
 * - selfie_completed
 * - expires_at
 * - created_at
 */
async function createDriverSession(pool, driverId) {
  const token = newToken();

  // expires in 24 hours (adjust if needed)
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await pool.query(
    `
    INSERT INTO driver_sessions (
      driver_id,
      token,
      selfie_completed,
      expires_at
    )
    VALUES ($1, $2, false, $3)
    `,
    [driverId, token, expiresAt]
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
    SELECT driver_id, selfie_completed, expires_at
    FROM driver_sessions
    WHERE token = $1
    LIMIT 1
    `,
    [token]
  );

  if (!rows.length) throw new Error("Invalid driver token");

  const session = rows[0];

  if (new Date(session.expires_at) < new Date()) {
    throw new Error("Driver session expired");
  }

  if (requireSelfie && !session.selfie_completed) {
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
