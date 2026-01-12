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
  return m ? m[1].trim() : "";
}

function newToken() {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Creates a driver session token row.
 * Schema we expect (we’ll add SQL below):
 * - driver_sessions(token, driver_id, selfie_verified, created_at, revoked_at)
 */
async function createDriverSession(pool, driverId) {
  const token = newToken();

  await pool.query(
    `
    INSERT INTO driver_sessions (token, driver_id, selfie_verified)
    VALUES ($1, $2, false)
    `,
    [token, driverId]
  );

  return token;
}

/**
 * Require a valid driver session token.
 * Optionally enforce selfie gate.
 */
async function requireDriver(pool, req, { requireSelfie = true } = {}) {
  const token = getBearerToken(req);
  if (!token) throw new Error("Missing Authorization: Bearer <token>");

  const { rows } = await pool.query(
    `
    SELECT token, driver_id, selfie_verified, revoked_at
    FROM driver_sessions
    WHERE token = $1
    LIMIT 1
    `,
    [token]
  );

  if (!rows.length) throw new Error("Invalid driver token");
  const session = rows[0];

  if (session.revoked_at) throw new Error("Driver session revoked");
  if (requireSelfie && !session.selfie_verified) throw new Error("Selfie required to proceed");

  return { token: session.token, driver_id: session.driver_id, selfie_verified: session.selfie_verified };
}

module.exports = { json, createDriverSession, requireDriver };
