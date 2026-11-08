"use strict";

const bucketName = "driver-documents";
const photoPrefix = "driver-records/";
const maxPhotoBytes = 1024 * 1024;

function photoError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

async function readPhoto(req) {
  if (req.headers["content-type"] !== "image/jpeg") {
    throw photoError(415, "Choose a JPEG driver photo.");
  }
  if (Number(req.headers["content-length"]) > maxPhotoBytes) {
    throw photoError(413, "The driver photo must be 1 MB or smaller.");
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maxPhotoBytes) {
      throw photoError(413, "The driver photo must be 1 MB or smaller.");
    }
    chunks.push(bytes);
  }
  const photo = Buffer.concat(chunks);
  if (size < 5 || photo[0] !== 0xff || photo[1] !== 0xd8 || photo[2] !== 0xff ||
      photo[size - 2] !== 0xff || photo[size - 1] !== 0xd9) {
    throw photoError(400, "The file is not a valid JPEG photo.");
  }
  return photo;
}

async function handleDriverRecordPhoto(req, res, pool, scope, method, json) {
  const driverQuery = "SELECT id FROM drivers WHERE company_id = $1 AND id = $2";

  if (method === "GET") {
    const driver = await pool.query(driverQuery, scope);
    if (!driver.rowCount) throw photoError(404, "Driver not found.");
    const path = photoPrefix + driver.rows[0].id + ".jpg";
    const { supabase } = require("../lib/supabase");
    const { data, error } = await supabase.storage.from(bucketName).download(path);
    if (error) {
      if (String(error.statusCode) === "404" || error.error === "not_found" ||
          error.error === "NoSuchKey" || error.message === "Object not found") {
        throw photoError(404, "No photo on file for this driver.");
      }
      throw photoError(502, "Could not load the driver photo. Try again.");
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    return res.end(Buffer.from(await data.arrayBuffer()));
  }

  if (method !== "PUT") throw photoError(405, "Method not allowed.");

  const photo = await readPhoto(req);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Keep the driver record present while the photo is saved.
    const driver = await client.query(driverQuery + " FOR SHARE", scope);
    if (!driver.rowCount) throw photoError(404, "Driver not found.");
    const path = photoPrefix + driver.rows[0].id + ".jpg";
    const { supabase } = require("../lib/supabase");
    const { error } = await supabase.storage.from(bucketName).upload(path, photo, {
      contentType: "image/jpeg",
      cacheControl: "0",
      upsert: true,
    });
    if (error) throw photoError(502, "Could not save the driver photo. Try again.");
    await client.query("COMMIT");
    return json(res, 200, { ok: true });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { bucketName, photoPrefix, handleDriverRecordPhoto };
