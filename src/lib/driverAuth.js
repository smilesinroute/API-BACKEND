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

function getCloudflareEmail(req) {
  return (
    req.headers["cf-access-authenticated-user-email"] ||
    req.headers["x-auth-request-email"] ||
    null
  );
}

function newToken() {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Create a driver session
 * Reads selfie status from drivers table
 */
async function createDriverSession(pool, driverId) {
  const token = newToken();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const { rowCount } = await pool.query(
    `
    INSERT INTO driver_sessions (
      driver_id,
      token,
      selfie_completed,
      expires_at
    )
    SELECT id, $2, COALESCE(selfie_verified, false), $3
    FROM drivers
    WHERE id = $1 AND active IS TRUE
    FOR SHARE
    `,
    [driverId, token, expiresAt]
  );

  if (!rowCount) return null;
  return token;
}

/**
 * Require valid driver session
 * Supports:
 * - Bearer token sessions
 * - Cloudflare Access email identity
 */
async function requireDriver(pool, req, { requireSelfie = true } = {}) {
  let token = getBearerToken(req);

  // If no token, try Cloudflare identity
  if (!token) {
    const email = getCloudflareEmail(req);

    if (email) {
      const { rows } = await pool.query(
        `SELECT id FROM drivers WHERE email = $1 LIMIT 1`,
        [email]
      );

      if (!rows.length) {
        throw new Error("Driver not found");
      }

      // Create session automatically
      token = await createDriverSession(pool, rows[0].id);
      if (!token) throw new Error("Driver inactive");
    } else {
      throw new Error("Missing Authorization token");
    }
  }

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
