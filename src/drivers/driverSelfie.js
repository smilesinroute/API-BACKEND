"use strict";

/**
 * Driver Selfie Upload (Production)
 * ---------------------------------
 * - Cloudflare Access identity ONLY
 * - No driver_id accepted from client
 * - Validates image uploads
 * - Resets verification on every upload
 */

const formidable = require("formidable");
const fs = require("fs");
const path = require("path");
const { supabase } = require("../lib/supabase");

/* ======================================================
   Helpers
====================================================== */

function json(res, status, payload) {
  if (res.writableEnded) return;

  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
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

/* ======================================================
   Main Handler
====================================================== */

async function handleDriverSelfie(req, res, pool) {

  const cfEmail = getCloudflareEmail(req);

  if (!cfEmail) {
    return json(res, 401, {
      ok: false,
      error: "Missing Cloudflare identity"
    });
  }

  try {

    /* --------------------------------------------------
       Resolve driver by Cloudflare identity
    -------------------------------------------------- */

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
      return json(res, 403, {
        ok: false,
        error: "Driver not authorized"
      });
    }

    /* --------------------------------------------------
       Parse upload
    -------------------------------------------------- */

    const form = formidable({
      maxFileSize: 5 * 1024 * 1024,
      keepExtensions: true,
      multiples: false
    });

    form.parse(req, async (err, _fields, files) => {

      if (err) {
        console.error("[DRIVER SELFIE] parse error:", err);
        return json(res, 400, {
          ok: false,
          error: "Invalid upload"
        });
      }

      const photo = files.photo;

      if (!photo) {
        return json(res, 400, {
          ok: false,
          error: "photo is required"
        });
      }

      if (!ALLOWED_MIME.has(photo.mimetype)) {
        return json(res, 415, {
          ok: false,
          error: "Unsupported image type"
        });
      }

      const ext =
        path.extname(photo.originalFilename || ".jpg")
          .toLowerCase();

      const storagePath =
        `drivers/${driver.id}/selfie${ext}`;

      try {

        /* --------------------------------------------------
           Upload to Supabase Storage
        -------------------------------------------------- */

        const buffer = fs.readFileSync(photo.filepath);

        const { error } = await supabase.storage
          .from("driver-photos")
          .upload(storagePath, buffer, {
            contentType: photo.mimetype,
            upsert: true
          });

        if (error) throw error;

        const publicUrl =
          supabase
            .storage
            .from("driver-photos")
            .getPublicUrl(storagePath)
            .data.publicUrl;

        /* --------------------------------------------------
           Update driver record
        -------------------------------------------------- */

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

        /* --------------------------------------------------
           Clean up temp file
        -------------------------------------------------- */

        try {
          fs.unlinkSync(photo.filepath);
        } catch (_) {}

        return json(res, 200, {
          ok: true,
          selfie_url: publicUrl
        });

      } catch (uploadErr) {

        console.error("[DRIVER SELFIE] upload error:", uploadErr);

        return json(res, 500, {
          ok: false,
          error: "Upload failed"
        });
      }
    });

  } catch (err) {

    console.error("[DRIVER SELFIE] server error:", err);

    return json(res, 500, {
      ok: false,
      error: "Server error"
    });
  }
}

module.exports = { handleDriverSelfie };