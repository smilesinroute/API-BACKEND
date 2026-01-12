"use strict";

const crypto = require("crypto");
const { json, createDriverSession, requireDriver } = require("../lib/driverAuth");
const { parseMultipart, fileToBuffer } = require("../lib/multipart");
const { uploadToStorage } = require("../lib/supabaseStorage");

/**
 * Driver API Step 1 endpoints:
 * - POST /api/driver/login            (email + pin) -> token (selfie NOT verified yet)
 * - POST /api/driver/selfie           (multipart file) -> marks session selfie_verified=true
 * - GET  /api/driver/me               (auth) -> driver profile + selfie status
 */

function asTrimmedString(v) {
  return String(v ?? "").trim();
}

function asLowerEmail(v) {
  return asTrimmedString(v).toLowerCase();
}

/**
 * Minimal JSON reader (standalone for this file)
 */
function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let finished = false;

    function finish(err, data) {
      if (finished) return;
      finished = true;
      if (err) reject(err);
      else resolve(data);
    }

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        return finish(new Error("Request body too large"));
      }
      chunks.push(chunk);
    });

    req.on("end", () => finish(null, Buffer.concat(chunks).toString("utf8")));
    req.on("error", (e) => finish(e));
  });
}

async function readJson(req) {
  const ct = String(req.headers["content-type"] || "");
  if (ct && !ct.toLowerCase().includes("application/json")) {
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

/**
 * Main driver route handler. Returns:
 * - true  if handled
 * - false if not handled
 */
async function handleDriverRoutes(req, res, pool, pathname, method) {
  // -------- POST /api/driver/login ----------
  if (pathname === "/api/driver/login" && method === "POST") {
    try {
      const body = await readJson(req);

      const email = asLowerEmail(body.email);
      const pin = asTrimmedString(body.pin);

      if (!email) return json(res, 400, { error: "email is required" });
      if (!pin) return json(res, 400, { error: "pin is required" });

      const { rows } = await pool.query(
        `
        SELECT id, email, pin_hash, active
        FROM drivers
        WHERE lower(email) = lower($1)
        LIMIT 1
        `,
        [email]
      );

      if (!rows.length) return json(res, 401, { error: "Invalid credentials" });

      const driver = rows[0];
      if (driver.active === false) return json(res, 403, { error: "Driver disabled" });

      // DEV MODE: pin_hash compares directly to pin.
      // NOTE: Replace with bcrypt compare when ready.
      if (String(driver.pin_hash || "") !== pin) {
        return json(res, 401, { error: "Invalid credentials" });
      }

      const token = await createDriverSession(pool, driver.id);

      return json(res, 200, {
        ok: true,
        token,
        driver_id: driver.id,
        selfie_required: true,
      });
    } catch (e) {
      console.error("[DRIVER] login error:", e.message);
      return json(res, 500, { error: "Server error" });
    }
  }

  // -------- POST /api/driver/selfie ----------
  if (pathname === "/api/driver/selfie" && method === "POST") {
    try {
      // Must be logged in, but selfie not required yet (we're uploading it now)
      const session = await requireDriver(pool, req, { requireSelfie: false });

      const { files } = await parseMultipart(req, { maxFileSize: 6 * 1024 * 1024 });
      const selfieFile = files && files.selfie;

      if (!selfieFile) return json(res, 400, { error: "Missing file field: selfie" });

      const buffer = await fileToBuffer(selfieFile);

      const mime = String(selfieFile.mimetype || "image/jpeg");
      const original = String(selfieFile.originalFilename || "");
      const ext = (original.split(".").pop() || "jpg").toLowerCase();

      // Store in Supabase Storage
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const key = crypto.randomUUID();
      const storagePath = `drivers/${session.driver_id}/selfies/${stamp}_${key}.${ext}`;

      const uploaded = await uploadToStorage({
        bucket: String(process.env.SUPABASE_STORAGE_BUCKET_DRIVER_SELFIES || "driver-selfies"),
        path: storagePath,
        buffer,
        contentType: mime,
      });

      // Record selfie upload
      await pool.query(
        `
        INSERT INTO driver_selfies (driver_id, token, storage_bucket, storage_path, public_url)
        VALUES ($1, $2, $3, $4, $5)
        `,
        [session.driver_id, session.token, uploaded.bucket, uploaded.path, uploaded.publicUrl]
      );

      // Mark session verified
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
        storage_path: uploaded.path,
        public_url: uploaded.publicUrl || null, // may be null if bucket private (recommended)
      });
    } catch (e) {
      console.error("[DRIVER] selfie error:", e.message);
      return json(res, 400, { error: e.message });
    }
  }

  // -------- GET /api/driver/me ----------
  if (pathname === "/api/driver/me" && method === "GET") {
    try {
      const session = await requireDriver(pool, req, { requireSelfie: false });

      const { rows } = await pool.query(
        `
        SELECT id, email, full_name, active
        FROM drivers
        WHERE id = $1
        LIMIT 1
        `,
        [session.driver_id]
      );

      if (!rows.length) return json(res, 404, { error: "Driver not found" });

      return json(res, 200, {
        ok: true,
        driver: rows[0],
        selfie_verified: Boolean(session.selfie_verified),
      });
    } catch (e) {
      console.error("[DRIVER] me error:", e.message);
      return json(res, 401, { error: e.message });
    }
  }

  return false; // not handled
}

module.exports = { handleDriverRoutes };
