"use strict";

const formidable = require("formidable");
const { supabase } = require("../lib/supabase");
const crypto = require("crypto");

function json(res, code, payload) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

/**
 * POST /api/driver/selfie
 * Headers:
 *   Authorization: Bearer DRIVER_SESSION_TOKEN
 *
 * FormData:
 *   file = image
 */
async function handleDriverSelfie(req, res, pool) {
  const auth = String(req.headers.authorization || "");
  if (!auth.startsWith("Bearer ")) {
    return json(res, 401, { error: "Missing driver token" });
  }

  const token = auth.replace("Bearer ", "").trim();

  // Verify driver session
  const { rows } = await pool.query(
    `
    SELECT ds.id, ds.driver_id
    FROM driver_sessions ds
    WHERE ds.session_token = $1
      AND ds.expires_at > NOW()
    `,
    [token]
  );

  if (!rows.length) {
    return json(res, 401, { error: "Invalid or expired driver session" });
  }

  const { driver_id, id: session_id } = rows[0];

  const form = formidable({
    maxFileSize: 5 * 1024 * 1024,
    keepExtensions: true,
  });

  form.parse(req, async (err, fields, files) => {
    if (err) {
      return json(res, 400, { error: "Invalid upload" });
    }

    const file = files.file?.[0];
    if (!file) {
      return json(res, 400, { error: "Missing selfie file" });
    }

    const ext = file.originalFilename.split(".").pop();
    const filename = `${driver_id}/${crypto.randomUUID()}.${ext}`;

    const buffer = require("fs").readFileSync(file.filepath);

    const { error: uploadError } = await supabase.storage
      .from("driver-selfies")
      .upload(filename, buffer, {
        contentType: file.mimetype,
        upsert: false,
      });

    if (uploadError) {
      return json(res, 500, { error: uploadError.message });
    }

    // Record selfie
    await pool.query(
      `
      INSERT INTO driver_selfies (driver_id, storage_path)
      VALUES ($1, $2)
      `,
      [driver_id, filename]
    );

    // Mark session complete
    await pool.query(
      `
      UPDATE driver_sessions
      SET selfie_completed = true
      WHERE id = $1
      `,
      [session_id]
    );

    return json(res, 200, {
      ok: true,
      message: "Selfie verified. Driver unlocked.",
    });
  });
}

module.exports = { handleDriverSelfie };
