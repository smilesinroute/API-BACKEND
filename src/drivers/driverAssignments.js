"use strict";

const { json } = require("../lib/driverAuth");

/**
 * Dispatch → Assign driver to order
 * POST /api/dispatch/assign-driver
 * Body: { order_id, driver_id }
 */
async function handleDriverAssignments(req, res, pool, pathname, method) {
  if (pathname !== "/api/dispatch/assign-driver" || method !== "POST") {
    return false;
  }

  try {
    const body = await readJson(req);
    const orderId = String(body.order_id || "").trim();
    const driverId = String(body.driver_id || "").trim();

    if (!orderId || !driverId) {
      return json(res, 400, { error: "order_id and driver_id are required" });
    }

    // Ensure driver exists and active
    const driverCheck = await pool.query(
      `SELECT id, active FROM drivers WHERE id = $1 LIMIT 1`,
      [driverId]
    );

    if (!driverCheck.rows.length) {
      return json(res, 404, { error: "Driver not found" });
    }

    if (driverCheck.rows[0].active === false) {
      return json(res, 403, { error: "Driver is disabled" });
    }

    // Assign order
    const result = await pool.query(
      `
      UPDATE orders
      SET
        assigned_driver_id = $2,
        status = 'assigned'
      WHERE id = $1
      RETURNING id, assigned_driver_id, status
      `,
      [orderId, driverId]
    );

    if (!result.rows.length) {
      return json(res, 404, { error: "Order not found" });
    }

    return json(res, 200, {
      ok: true,
      order: result.rows[0],
    });
  } catch (e) {
    console.error("[DISPATCH] assign-driver error:", e.message);
    return json(res, 500, { error: "Server error" });
  }
}

/* ---------- minimal JSON helpers ---------- */

function readBody(req, maxBytes = 1_000_000) {
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

    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
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

module.exports = { handleDriverAssignments };
