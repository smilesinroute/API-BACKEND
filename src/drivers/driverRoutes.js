"use strict";

/**
 * src/drivers/driverRoutes.js
 *
 * Driver Routes (Production) — Cloudflare Only
 * --------------------------------------------
 * ✅ Cloudflare Access identity header is the ONLY auth source
 * ✅ No passwords, no JWT, no sessions
 * ✅ Enforces selfie requirement after "login"
 * ✅ Fetches assigned orders for the driver
 * ✅ Detects DB columns at runtime to avoid guessing (email column, etc.)
 *
 * Endpoints:
 *   GET  /api/driver/me
 *   GET  /api/driver/orders
 *
 * Required Cloudflare header:
 *   cf-access-authenticated-user-email  (or x-cf-access-authenticated-user-email)
 *
 * Notes:
 * - If drivers.email does NOT exist, this will return a clear error telling you what to add.
 * - Selfie upload is handled elsewhere (your existing selfie route). This file only ENFORCES it.
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
  // Cloudflare Access commonly uses one of these
  const v =
    req.headers["cf-access-authenticated-user-email"] ||
    req.headers["x-cf-access-authenticated-user-email"];
  return normalizeEmail(v);
}

/* --------------------------------------------------
   Schema detection (prevents guessing)
-------------------------------------------------- */

let _schemaCache = null;

async function loadSchema(db) {
  if (_schemaCache) return _schemaCache;

  // Keep queries small + compatible with Postgres
  const [driversCols, ordersCols] = await Promise.all([
    db.query(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'drivers'
      `
    ),
    db.query(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'orders'
      `
    ),
  ]);

  const drivers = new Set((driversCols.rows || []).map((r) => r.column_name));
  const orders = new Set((ordersCols.rows || []).map((r) => r.column_name));

  _schemaCache = { drivers, orders };
  return _schemaCache;
}

/* --------------------------------------------------
   Driver lookup (Cloudflare email -> driver row)
-------------------------------------------------- */

async function findDriverByCloudflareEmail(db, cfEmail) {
  const schema = await loadSchema(db);

  // We do NOT guess. If there's no email column, we fail clearly.
  if (!schema.drivers.has("email")) {
    return {
      error:
        "drivers.email column is missing. Add an email column to drivers so Cloudflare email can map to a driver record.",
      status: 500,
    };
  }

  const { rows } = await db.query(
    `
    SELECT *
    FROM drivers
    WHERE lower(email) = lower($1)
    LIMIT 1
    `,
    [cfEmail]
  );

  const driver = rows[0] || null;
  if (!driver) return { error: "Driver not found", status: 403 };

  // Optional safety checks if columns exist
  if (schema.drivers.has("active") && driver.active === false) {
    return { error: "Driver inactive", status: 403 };
  }
  if (schema.drivers.has("status") && String(driver.status || "") === "inactive") {
    return { error: "Driver inactive", status: 403 };
  }

  return { driver };
}

function selfieIsRequired(driver) {
  // If your schema has selfie_verified, enforce it. If it doesn't, don't block.
  // (But your earlier output shows selfie_verified exists.)
  if (typeof driver.selfie_verified === "boolean") {
    return driver.selfie_verified !== true;
  }
  return false;
}

/* --------------------------------------------------
   Route Handlers
-------------------------------------------------- */

async function handleDriverMe(req, res, db) {
  const cfEmail = getCloudflareEmail(req);
  if (!cfEmail) {
    return sendJSON(res, 401, {
      error: "Missing Cloudflare identity header",
      hint: "Driver must access via Cloudflare-protected domain",
    });
  }

  const found = await findDriverByCloudflareEmail(db, cfEmail);
  if (found.error) return sendJSON(res, found.status || 403, { error: found.error });

  const driver = found.driver;

  return sendJSON(res, 200, {
    ok: true,
    driver: {
      id: driver.id,
      name: driver.name ?? null,
      email: driver.email ?? null,
      selfie_verified:
        typeof driver.selfie_verified === "boolean" ? driver.selfie_verified : null,
      selfie_image_url: driver.selfie_image_url ?? null,
      last_selfie_at: driver.last_selfie_at ?? null,
    },
    selfie_required: selfieIsRequired(driver),
  });
}

async function handleDriverOrders(req, res, db) {
  const cfEmail = getCloudflareEmail(req);
  if (!cfEmail) {
    return sendJSON(res, 401, {
      error: "Missing Cloudflare identity header",
      hint: "Driver must access via Cloudflare-protected domain",
    });
  }

  const found = await findDriverByCloudflareEmail(db, cfEmail);
  if (found.error) return sendJSON(res, found.status || 403, { error: found.error });

  const driver = found.driver;

  // Enforce selfie AFTER login
  if (selfieIsRequired(driver)) {
    return sendJSON(res, 403, {
      error: "Selfie required",
      selfie_required: true,
    });
  }

  const schema = await loadSchema(db);

  // Ensure the orders table supports assignment
  if (!schema.orders.has("assigned_driver_id")) {
    return sendJSON(res, 500, {
      error:
        "orders.assigned_driver_id column is missing. Driver assignments cannot work without it.",
    });
  }

  // Return assigned + active orders for this driver
  // (Keep status list aligned with your workflow)
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

  return sendJSON(res, 200, { ok: true, orders: rows });
}

/* --------------------------------------------------
   Main Router
-------------------------------------------------- */

async function handleDriverRoutes(req, res, db) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || "/";
  const method = String(req.method || "GET").toUpperCase();

  // Driver profile / selfie requirement check
  if (pathname === "/api/driver/me" && method === "GET") {
    await handleDriverMe(req, res, db);
    return true;
  }

  // Driver assigned orders
  if (pathname === "/api/driver/orders" && method === "GET") {
    await handleDriverOrders(req, res, db);
    return true;
  }

  return false;
}

module.exports = { handleDriverRoutes };
