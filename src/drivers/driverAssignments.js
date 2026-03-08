"use strict";

const { json } = require("../lib/driverAuth");

/* ======================================================
   HELPERS
====================================================== */

async function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on("data", (chunk) => {
      total += chunk.length;

      if (total > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", reject);
  });
}

async function readJson(req) {
  const body = await readBody(req);

  if (!body) return {};

  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

/* ======================================================
   POST /api/dispatch/assign-driver
   Manual dispatcher assignment
====================================================== */

async function handleDriverAssignments(req, res, pool, pathname, method) {

  if (pathname !== "/api/dispatch/assign-driver" || method !== "POST") {
    return false;
  }

  try {

    const body = await readJson(req);

    const orderId = String(body.order_id || "").trim();
    const driverId = String(body.driver_id || "").trim();

    if (!orderId || !driverId) {
      return json(res, 400, {
        ok: false,
        error: "order_id and driver_id are required"
      });
    }

    /* --------------------------------------------------
       Verify driver exists and is active
    -------------------------------------------------- */

    const driverCheck = await pool.query(
      `
      SELECT id, active
      FROM drivers
      WHERE id = $1
      LIMIT 1
      `,
      [driverId]
    );

    if (!driverCheck.rows.length) {
      return json(res, 404, {
        ok: false,
        error: "Driver not found"
      });
    }

    if (driverCheck.rows[0].active === false) {
      return json(res, 403, {
        ok: false,
        error: "Driver is disabled"
      });
    }

    /* --------------------------------------------------
       Assign order safely
    -------------------------------------------------- */

    const result = await pool.query(
      `
      UPDATE orders
      SET
        assigned_driver_id = $2,
        status = 'assigned',
        assigned_at = NOW()
      WHERE id = $1
        AND status = 'ready_for_dispatch'
        AND assigned_driver_id IS NULL
      RETURNING
        id,
        assigned_driver_id,
        status
      `,
      [orderId, driverId]
    );

    if (!result.rows.length) {
      return json(res, 409, {
        ok: false,
        error: "Order unavailable for assignment"
      });
    }

    return json(res, 200, {
      ok: true,
      order: result.rows[0]
    });

  } catch (err) {

    console.error("[DISPATCH] assign-driver error:", err);

    return json(res, 500, {
      ok: false,
      error: "Server error"
    });
  }
}

module.exports = { handleDriverAssignments };