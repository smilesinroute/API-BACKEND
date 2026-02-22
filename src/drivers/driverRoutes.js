"use strict";

/**
 * Driver Routes — Token Based
 * Only handles lightweight profile route.
 * Orders handled by driverOrders.js
 */

const url = require("url");
const { requireDriver } = require("../lib/driverAuth");

/* -------------------------------------------------- */
function sendJSON(res, status, data) {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

/* -------------------------------------------------- */
async function handleDriverRoutes(req, res, db) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || "/";
  const method = String(req.method || "GET").toUpperCase();

  // GET /api/driver/me
  if (pathname === "/api/driver/me" && method === "GET") {
    try {
      const session = await requireDriver(db, req, { requireSelfie: false });

      const { rows } = await db.query(
        `
        SELECT id, full_name, email, selfie_verified
        FROM drivers
        WHERE id = $1
        LIMIT 1
        `,
        [session.driver_id]
      );

      if (!rows.length) {
        return sendJSON(res, 404, { error: "Driver not found" });
      }

      return sendJSON(res, 200, {
        ok: true,
        driver: rows[0],
      });

    } catch (err) {
      return sendJSON(res, 401, { error: err.message });
    }
  }

  return false;
}

module.exports = { handleDriverRoutes };