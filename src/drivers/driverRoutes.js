"use strict";

/**
 * Driver Routes — Token Based
 * ============================
 * Handles lightweight authenticated driver routes.
 * Order workflows are handled in driverOrders.js
 */

const { URL } = require("url");
const { requireDriver } = require("../lib/driverAuth");

/* ======================================================
   RESPONSE HELPER
====================================================== */

function sendJSON(res, status, payload) {
  if (res.writableEnded) return;

  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

/* ======================================================
   ROUTE HANDLER
====================================================== */

async function handleDriverRoutes(req, res, db) {

  const parsed = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsed.pathname || "/";
  const method = String(req.method || "GET").toUpperCase();

  /* ======================================================
     GET /api/driver/me
     Returns authenticated driver profile
     - Requires valid session
     - Does NOT require selfie verification
  ====================================================== */

  if (pathname === "/api/driver/me" && method === "GET") {

    try {

      const session = await requireDriver(db, req, {
        requireSelfie: false
      });

      const { rows } = await db.query(
        `
        SELECT
          id,
          full_name,
          email,
          active,
          status,
          selfie_verified,
          created_at
        FROM drivers
        WHERE id = $1
        LIMIT 1
        `,
        [session.driver_id]
      );

      if (!rows.length) {
        return sendJSON(res, 404, {
          ok: false,
          error: "Driver not found"
        });
      }

      return sendJSON(res, 200, {
        ok: true,
        driver: rows[0]
      });

    } catch (err) {

      console.error("[DRIVER] auth error:", err);

      return sendJSON(res, 401, {
        ok: false,
        error: err.message || "Unauthorized"
      });

    }
  }

  /* ======================================================
     No route matched
====================================================== */

  return false;
}

module.exports = { handleDriverRoutes };