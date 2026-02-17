"use strict";

/**
 * Driver Selfie Upload (Production)
 * ---------------------------------
 * - Cloudflare Access identity ONLY
 * - No driver_id from client
 * - Enforces image uploads
 * - Resets verification on every upload
 */

const formidable = require("formidable");
const fs = require("fs");
const path = require("path");
const { supabase } = require("../lib/supabase");

/* --------------------------------------------------
   Helpers
-------------------------------------------------- */

function send(res, status, message) {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.end(message);
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

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp"
]);

/* --------------------------------------------------
   Main handler
-------------------------------------------------- */

async function handleDriverSelfie(req, res, pool) {
  const cfEmail = getCloudflareEmail(req);

  if (!cfEmail) {
    return send(res, 401, "Missing Cloudflare identity");
  }

  // Resolve driver from Cloudflare email
  const { rows } = await pool.query(
    `
    SELECT id
    FROM drivers
    WHERE lower(email) = lower($1)
    LIMIT 1
    `,
    [cfEmail]
  );

  const driver = rows[0];
  if (!driver) {
    return send(res, 403, "Driver not authorized");
  }

  const form = formidable({
    maxFileSize: 5 * 1024 * 1024, // 5MB
    keepExtensions: true,
    multiples: false,
  });

  form.parse(req, async (err, _fields, files) => {
    if (err) {
      return send(res, 400, "Invalid upload");
    }

    const photo = files.photo;
    if (!photo) {
      return send(res, 400, "photo is required");
    }

    if (!ALLOWED_MIME.has(photo.mimetype)) {
      return send(res, 415, "Unsupported image type");
    }

    const ext = path.extname(photo.originalFilename || ".jpg");
    const storagePath = `drivers/${driver.id}/selfie${ext}`;

    try {
      const buffer = fs.readFileSync(photo.filepath);

      const { error } = await supabase.storage
        .from("driver-photos")
        .upload(storagePath, buffer, {
          contentType: photo.mimetype,
          upsert: true,
        });

      if (error) throw error;

      const publicUrl =
        supabase.storage
          .from("driver-photos")
          .getPublicUrl(storagePath).data.publicUrl;

      await pool.query(
        `
        UPDATE drivers
        SET
          selfie_uploaded = true,
          selfie_verified = false,
          selfie_image_url = $2,
          last_selfie_at = NOW()
        WHERE id = $1
        `,
        [driver.id, publicUrl]
      );

      return send(res, 200, "Selfie uploaded");
    } catch (e) {
      console.error("[DRIVER SELFIE]", e);
      return send(res, 500, "Upload failed");
    }
  });
}

module.exports = { handleDriverSelfie };
