"use strict";

/**
 * src/drivers/driverRoutes.js
 *
 * Driver Routes — Cloudflare Identity Only
 * ----------------------------------------
 * Auth model:
 *   - Driver accesses site through Cloudflare Access
 *   - Cloudflare injects driver email header
 *   - API matches email → drivers table
 *
 * Security:
 *   - No passwords
 *   - No JWT
 *   - No sessions
 *   - Selfie required before order access
 *
 * Endpoints:
 *   GET /api/driver/me
 *   GET /api/driver/orders
 */

const url = require("url");

/* --------------------------------------------------
   Response helpers
-------------------------------------------------- */
function sendJSON(res, status, data) {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function normalizeEmail(v) {
  return String(v || "").trim().toLowerCase();
}

function getCloudflareEmail(req) {
  return normalizeEmail(
    req.headers["cf-access-authenticated-user-email"] ||
    req.headers["x-cf-access-authenticated-user-email"]
  );
}

/* --------------------------------------------------
   Driver lookup
-------------------------------------------------- */
async function findDriverByEmail(db, email) {
  const { rows } = await db.query(
    `
    SELECT
      id,
      name,
      email,
      active,
      status,
      selfie_verified,
      selfie_image_url,
      last_selfie_at
    FROM drivers
    WHERE lower(email) = lower($1)
    LIMIT 1
    `,
    [email]
  );

  const driver = rows[0];
  if (!driver) {
    return { error: "Driver not found", status: 403 };
  }

  if (driver.active === false || driver.status === "inactive") {
    return { error: "Driver inactive", status: 403 };
  }

  return { driver };
}

function selfieIsRequired(driver) {
  return driver.selfie_verified !== true;
}

/* --------------------------------------------------
   Route handlers
-------------------------------------------------- */

async function handleDriverMe(req, res, db) {
  const email = getCloudflareEmail(req);

  if (!email) {
    return sendJSON(res, 401, {
      error: "Missing Cloudflare identity header",
      hint: "Access driver portal through Cloudflare-protected domain",
    });
  }

  const result = await findDriverByEmail(db, email);
  if (result.error) {
    return sendJSON(res, result.status || 403, {
      error: result.error,
    });
  }

  const driver = result.driver;

  return sendJSON(res, 200, {
    ok: true,
    driver: {
      id: driver.id,
      name: driver.name,
      email: driver.email,
      selfie_verified: driver.selfie_verified,
      selfie_image_url: driver.selfie_image_url,
      last_selfie_at: driver.last_selfie_at,
    },
    selfie_required: selfieIsRequired(driver),
  });
}

async function handleDriverOrders(req, res, db) {
  const email = getCloudflareEmail(req);

  if (!email) {
    return sendJSON(res, 401, {
      error: "Missing Cloudflare identity header",
    });
  }

  const result = await findDriverByEmail(db, email);
  if (result.error) {
    return sendJSON(res, result.status || 403, {
      error: result.error,
    });
  }

  const driver = result.driver;

  // Enforce selfie before orders
  if (selfieIsRequired(driver)) {
    return sendJSON(res, 403, {
      error: "Selfie required",
      selfie_required: true,
    });
  }

  const { rows } = await db.query(
    `
    SELECT
      id,
      service_type,
      status,
      pickup_address,
      delivery_address,
      scheduled_date,
      scheduled_time,
      distance_miles,
      total_amount,
      payment_status,
      created_at,
      assigned_at,
      picked_up_at,
      delivered_at
    FROM orders
    WHERE assigned_driver_id = $1
      AND status IN ('assigned', 'in_progress', 'ready_for_dispatch')
    ORDER BY created_at ASC
    `,
    [driver.id]
  );

  return sendJSON(res, 200, {
    ok: true,
    orders: rows,
  });
}

/* --------------------------------------------------
   Main router
-------------------------------------------------- */

async function handleDriverRoutes(req, res, db) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || "/";
  const method = String(req.method || "GET").toUpperCase();

  if (pathname === "/api/driver/me" && method === "GET") {
    await handleDriverMe(req, res, db);
    return true;
  }

  if (pathname === "/api/driver/orders" && method === "GET") {
    await handleDriverOrders(req, res, db);
    return true;
  }

  return false;
}

module.exports = { handleDriverRoutes };
