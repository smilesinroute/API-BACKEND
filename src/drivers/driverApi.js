"use strict";

const formidable = require("formidable");
const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");

/* =========================
   Supabase Client (Storage)
========================= */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* =========================
   Helpers
========================= */
function json(res, code, payload) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

/* =========================
   DRIVER LOGIN
========================= */
async function driverLogin(req, res, pool) {
  try {
    const { email } = await readJson(req);
    if (!email) throw new Error("email is required");

    const { rows } = await pool.query(
      `
      SELECT id, full_name, selfie_url
      FROM drivers
      WHERE email = $1
        AND active = true
      LIMIT 1
      `,
      [email.toLowerCase()]
    );

    if (!rows.length) throw new Error("Driver not found");

    const d = rows[0];

    return json(res, 200, {
      ok: true,
      driver: {
        id: d.id,
        full_name: d.full_name,
        selfie_required: !d.selfie_url
      }
    });
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
}

/* =========================
   DRIVER SELFIE UPLOAD
========================= */
async function driverSelfie(req, res, pool) {
  const form = formidable({ multiples: false });

  form.parse(req, async (err, fields, files) => {
    try {
      if (err) throw new Error("Invalid form data");

      const driverId = fields.driver_id;
      const file = files.file;

      if (!driverId || !file) {
        throw new Error("driver_id and file are required");
      }

      const buffer = fs.readFileSync(file.filepath);
      const filename = `driver-${driverId}-${Date.now()}.jpg`;

      const { error } = await supabase.storage
        .from("driver-selfies")
        .upload(filename, buffer, {
          contentType: "image/jpeg",
          upsert: false
        });

      if (error) throw error;

      const { data } = await supabase.storage
        .from("driver-selfies")
        .createSignedUrl(filename, 60 * 60 * 24 * 365);

      await pool.query(
        `
        UPDATE drivers
        SET selfie_url = $2
        WHERE id = $1
        `,
        [driverId, data.signedUrl]
      );

      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  });
}

module.exports = { driverLogin, driverSelfie };
