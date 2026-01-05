"use strict";

const formidable = require("formidable");
const fs = require("fs");
const path = require("path");
const { supabase } = require("../lib/supabase");

async function handleDriverSelfie(req, res, pool) {
  const form = formidable({
    maxFileSize: 5 * 1024 * 1024, // 5MB
    keepExtensions: true,
  });

  form.parse(req, async (err, fields, files) => {
    if (err) {
      res.statusCode = 400;
      return res.end("Invalid upload");
    }

    const driverId = String(fields.driver_id || "").trim();
    const photo = files.photo;

    if (!driverId || !photo) {
      res.statusCode = 400;
      return res.end("driver_id and photo are required");
    }

    const filePath = photo.filepath;
    const ext = path.extname(photo.originalFilename || ".jpg");
    const storagePath = `drivers/${driverId}/selfie${ext}`;

    try {
      const fileBuffer = fs.readFileSync(filePath);

      const { error } = await supabase.storage
        .from("driver-photos")
        .upload(storagePath, fileBuffer, {
          contentType: photo.mimetype,
          upsert: true,
        });

      if (error) throw error;

      await pool.query(
        `
        UPDATE drivers
        SET
          selfie_uploaded = true,
          selfie_verified = false,
          selfie_uploaded_at = NOW()
        WHERE id = $1
        `,
        [driverId]
      );

      res.statusCode = 200;
      res.end("Selfie uploaded");
    } catch (e) {
      console.error("[DRIVER SELFIE]", e.message);
      res.statusCode = 500;
      res.end("Upload failed");
    }
  });
}

module.exports = { handleDriverSelfie };
