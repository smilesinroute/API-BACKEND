"use strict";

const crypto = require("crypto");

/* =========================
   JSON helper
========================= */
function json(res, code, payload) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

/* =========================
   Token helpers
========================= */
function getBearerToken(req) {
  const auth = String(req.headers.authorization || "");
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

function newToken() {
  return crypto.randomBytes(32).toString("hex");
}

/* =========================
   Create driver session
   TABLE: driver_sessions(token, driver_id, created_at, revoked_at)
========================= */
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

/* =========================
   Require driver
   - Auth via driver_sessions
   - Selfie enforced via driver_selfies
========================= */
async function requireDriver(pool, req, { requireSelfie = true } = {}) {
  const token = getBearerToken(req);
  if (!token) throw new Error("Missing Authorization token");

  /* ---- validate session ---- */
  const { rows: sessions } = await pool.query(
    `
    SELECT token, driver_id, revoked_at
    FROM driver_sessions
    WHERE token = $1
    LIMIT 1
    `,
    [token]
  );

  if (!sessions.length) throw new Error("Invalid driver token");

  const session = sessions[0];
  if (session.revoked_at) throw new Error("Driver session revoked");

  /* ---- selfie gate ---- */
  if (requireSelfie) {
    const { rows: selfies } = await pool.query(
      `
      SELECT id
      FROM driver_selfies
      WHERE driver_id = $1
        AND verified = true
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [session.driver_id]
    );

    if (!selfies.length) {
      throw new Error("Selfie required to proceed");
    }
  }

  return {
    token: session.token,
    driver_id: session.driver_id,
  };
}

module.exports = {
  json,
  createDriverSession,
  requireDriver,
};
