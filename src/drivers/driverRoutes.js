"use strict";

const crypto = require("crypto");
const {
  json,
  createDriverSession,
  requireDriver,
} = require("../lib/driverAuth");
const { parseMultipart, fileToBuffer } = require("../lib/multipart");
const { uploadToStorage } = require("../lib/supabaseStorage");

/**
 * ======================================================
 * DRIVER API ROUTES
 * ======================================================
 *
 * POST /api/driver/login
 * POST /api/driver/selfie
 * GET  /api/driver/me
 * GET  /api/driver/orders
 *
 * NOTE:
 * Custom HTTP router (no Express)
 */

/* ======================================================
   HELPERS
====================================================== */

function asTrimmedString(v) {
  return String(v ?? "").trim();
}

function asLowerEmail(v) {
  return asTrimmedString(v).toLowerCase();
}

/* ======================================================
   BODY PARSING
====================================================== */

function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () =>
      resolve(Buffer.concat(chunks).toString("utf8"))
    );
    req.on("error", reject);
  });
}

async function readJson(req) {
  const ct = String(req.headers["content-type"] || "").toLowerCase();
  if (ct && !ct.includes("application/json")) {
    throw new Error("Content-Type must be application/json");
  }

  const body = await readBody(req);
  if (!body) return {};

  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

/* ======================================================
   ROUTER
====================================================== */

async function handleDriverRoutes(req, res, pool, pathname, method) {

  /* ======================================================
     POST /api/driver/login
  ====================================================== */
  if (pathname === "/api/driver/login" && method === "POST") {
    try {
      const body = await readJson(req);
      const email = asLowerEmail(body.email);
      const pin = asTrimmedString(body.pin);

      if (!email) return json(res, 400, { error: "email is required" });
      if (!pin) return json(res, 400, { error: "pin is required" });

      const { rows } = await pool.query(
        `
        SELECT id, email, status
        FROM drivers
        WHERE lower(email) = lower($1)
        LIMIT 1
        `,
        [email]
      );

      if (!rows.length) {
        return json(res, 401, { error: "Invalid credentials" });
      }

      const driver = rows[0];
      if (driver.status === "offline") {
        return json(res, 403, { error: "Driver inactive" });
      }

      const token = await createDriverSession(pool, driver.id);

      return json(res, 200, {
        ok: true,
        token,
        driver_id: driver.id,
        selfie_required: true,
      });
    } catch (err) {
      console.error("[DRIVER] login error:", err.message);
      return json(res, 500, { error: "Server error" });
    }
  }

  /* ======================================================
     POST /api/driver/selfie
  ====================================================== */
  if (pathname === "/api/driver/selfie" && method === "POST") {
    try {
      const session = await requireDriver(pool, req, {
        requireSelfie: false,
      });

      const { files } = await parseMultipart(req, {
        maxFileSize: 6 * 1024 * 1024,
      });

      const selfieFile = files?.selfie;
      if (!selfieFile) {
        return json(res, 400, { error: "Missing selfie file" });
      }

      const buffer = await fileToBuffer(selfieFile);
      const mime = String(selfieFile.mimetype || "image/jpeg");
      const ext =
        String(selfieFile.originalFilename || "jpg")
          .split(".")
          .pop()
          .toLowerCase();

      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const key = crypto.randomUUID();

      const storagePath =
        `drivers/${session.driver_id}/selfies/${stamp}_${key}.${ext}`;

      const uploaded = await uploadToStorage({
        bucket:
          process.env.SUPABASE_STORAGE_BUCKET_DRIVER_SELFIES ||
          "driver-selfies",
        path: storagePath,
        buffer,
        contentType: mime,
      });

      await pool.query(
        `
        UPDATE driver_sessions
        SET selfie_verified = true
        WHERE token = $1
        `,
        [session.token]
      );

      return json(res, 200, {
        ok: true,
        driver_id: session.driver_id,
        selfie_verified: true,
        public_url: uploaded.publicUrl || null,
      });
    } catch (err) {
      console.error("[DRIVER] selfie error:", err.message);
      return json(res, 400, { error: err.message });
    }
  }

  /* ======================================================
     GET /api/driver/me
  ====================================================== */
  if (pathname === "/api/driver/me" && method === "GET") {
    try {
      const session = await requireDriver(pool, req, {
        requireSelfie: false,
      });

      const { rows } = await pool.query(
        `
        SELECT
          id,
          name,
          email,
          phone,
          vehicle_type,
          status,
          selfie_verified
        FROM drivers
        WHERE id = $1
        `,
        [session.driver_id]
      );

      if (!rows.length) {
        return json(res, 404, { error: "Driver not found" });
      }

      return json(res, 200, {
        ok: true,
        driver: rows[0],
      });
    } catch (err) {
      console.error("[DRIVER] me error:", err.message);
      return json(res, 401, { error: err.message });
    }
  }

  /* ======================================================
     GET /api/driver/orders
     → Assigned + active jobs for driver
  ====================================================== */
  if (pathname === "/api/driver/orders" && method === "GET") {
    try {
      const session = await requireDriver(pool, req, {
        requireSelfie: true,
      });

      const { rows } = await pool.query(
        `
        SELECT
          o.id,
          o.status,
          o.pickup_address,
          o.delivery_address,
          o.scheduled_date,
          o.scheduled_time
        FROM orders o
        WHERE o.assigned_driver_id = $1
          AND o.status IN ('assigned', 'in_progress')
        ORDER BY o.scheduled_date ASC, o.scheduled_time ASC
        `,
        [session.driver_id]
      );

      return json(res, 200, {
        ok: true,
        orders: rows,
      });
    } catch (err) {
      console.error("[DRIVER] orders error:", err.message);
      return json(res, 401, { error: err.message });
    }
  }

  return false;
}

module.exports = { handleDriverRoutes };
