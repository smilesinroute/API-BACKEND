"use strict";

const crypto = require("crypto");

/* ======================================================
   RESPONSE HELPER
====================================================== */
function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

/* ======================================================
   TOKEN HELPERS
====================================================== */
function getBearerToken(req) {
  const header = String(req.headers.authorization || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function newToken() {
  return crypto.randomBytes(32).toString("hex");
}

/* ======================================================
   DRIVER SESSION CREATION
   TABLE: driver_sessions
   - token (text, pk)
   - driver_id (uuid)
   - created_at (timestamptz)
   - revoked_at (timestamptz)
====================================================== */
async function createDriverSession(pool, driverId) {
  const token = newToken();

  await pool.query(
    `
    INSERT INTO driver_sessions (token, driver_id)
    VALUES ($1, $2)
    `,
    [token, driverId]
  );

  return token;
}

/* ======================================================
   REQUIRE DRIVER (AUTH MIDDLEWARE)
====================================================== */
async function requireDriver(pool, req, { requireSelfie = true } = {}) {
  const token = getBearerToken(req);

  if (!token) {
    const err = new Error("Missing Authorization bearer token");
    err.statusCode = 401;
    throw err;
  }

  /* =========================
     VALIDATE SESSION
  ========================= */
  const { rows: sessions } = await pool.query(
    `
    SELECT token, driver_id, revoked_at
    FROM driver_sessions
    WHERE token = $1
    LIMIT 1
    `,
    [token]
  );

  if (!sessions.length) {
    const err = new Error("Invalid or expired driver session");
    err.statusCode = 401;
    throw err;
  }

  const session = sessions[0];

  if (session.revoked_at) {
    const err = new Error("Driver session revoked");
    err.statusCode = 401;
    throw err;
  }

  /* =========================
     SELFIE ENFORCEMENT
     SOURCE OF TRUTH:
     driver_selfies table
  ========================= */
  if (requireSelfie) {
    const { rowCount } = await pool.query(
      `
      SELECT 1
      FROM driver_selfies
      WHERE driver_id = $1
        AND verified = true
      LIMIT 1
      `,
      [session.driver_id]
    );

    if (!rowCount) {
      const err = new Error("Driver selfie verification required");
      err.statusCode = 403;
      throw err;
    }
  }

  /* =========================
     SUCCESS
  ========================= */
  return {
    driver_id: session.driver_id,
    token: session.token,
  };
}

module.exports = {
  json,
  createDriverSession,
  requireDriver,
};
