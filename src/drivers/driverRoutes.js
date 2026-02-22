"use strict";

/**
 * Driver Routes — Token Based
 * ============================
 * Handles lightweight authenticated driver routes.
 * Orders handled separately in driverOrders.js
 */

const url = require("url");
const { requireDriver } = require("../lib/driverAuth");

/* ======================================================
   RESPONSE HELPER
====================================================== */
function sendJSON(res, status, data) {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

/* ======================================================
   ROUTE HANDLER
====================================================== */
async function handleDriverRoutes(req, res, db) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || "/";
  const method = String(req.method || "GET").toUpperCase();

  /* ======================================================
     GET /api/driver/me
     - Requires valid token
     - Does NOT require selfie
  ====================================================== */
  if (pathname === "/api/driver/me" && method === "GET") {
    try {
      const session = await requireDriver(db, req, {
        requireSelfie: false,
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
          error: "Driver not found",
        });
      }

      return sendJSON(res, 200, {
        ok: true,
        driver: rows[0],
      });

    } catch (err) {
      return sendJSON(res, 401, {
        ok: false,
        error: err.message || "Unauthorized",
      });
    }
  }

  return false;
}

module.exports = { handleDriverRoutes };