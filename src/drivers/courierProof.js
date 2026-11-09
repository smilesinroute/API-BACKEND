"use strict";

const { randomUUID } = require("node:crypto");
const { verifyDriverAccess } = require("../lib/driverAccess");

const bucket = "driver-documents";
const maxBytes = 1024 * 1024;
const idPattern = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const route = new RegExp("^/api/driver/orders/(" + idPattern + ")/(pickup|delivery)$", "i");
const storagePath = new RegExp("^order-proofs/" + idPattern + "/(?:pickup|delivery)-" + idPattern + "\\.jpg$", "i");

function fail(statusCode, message) {
  throw Object.assign(new Error(message), { statusCode });
}

async function readPhoto(req) {
  if (req.headers["content-type"] !== "image/jpeg") fail(415, "Choose a JPEG proof photo.");
  if (Number(req.headers["content-length"]) > maxBytes) fail(413, "The proof photo must be 1 MB or smaller.");
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) fail(413, "The proof photo must be 1 MB or smaller.");
    chunks.push(bytes);
  }
  const photo = Buffer.concat(chunks);
  if (size < 5 || photo[0] !== 0xff || photo[1] !== 0xd8 || photo[2] !== 0xff ||
      photo[size - 2] !== 0xff || photo[size - 1] !== 0xd9) {
    fail(400, "Choose a valid JPEG proof photo.");
  }
  return photo;
}

async function saveProof(pool, email, orderId, kind, photo) {
  const client = await pool.connect();
  let upload;
  let path;
  let committing = false;
  try {
    await client.query("BEGIN");
    const drivers = await client.query(
      "SELECT id, active, status, company_id FROM public.drivers WHERE lower(email) = $1 LIMIT 2 FOR SHARE", [email]
    );
    const [driver] = drivers.rows;
    if (drivers.rows.length !== 1 || driver.company_id !== 1 || driver.active !== true || driver.status === "inactive") {
      fail(403, "This Cloudflare account is not registered as an active driver.");
    }
    const { rows } = await client.query(
      `SELECT status, pickup_photo_taken, pickup_photo_url, delivery_photo_taken, delivered_photo_url
       FROM public.orders
       WHERE id = $1 AND assigned_driver_id = $2 AND service_type = 'courier'
         AND payment_status = 'paid' AND (company_id = 1 OR company_id IS NULL)
       FOR UPDATE`, [orderId, driver.id]
    );
    if (!rows.length) fail(404, "This paid courier order is unavailable to your driver account.");
    const [order] = rows;
    const pickup = kind === "pickup";
    const hasPickup = !!(order.pickup_photo_taken || order.pickup_photo_url);
    const hasDelivery = !!(order.delivery_photo_taken || order.delivered_photo_url);
    const done = order.status === "completed" || order.status === "delivered";
    const underway = ["en_route", "in_progress", "picked_up", "out_for_delivery"].includes(order.status);
    if ((pickup && hasPickup && (underway || done)) || (!pickup && hasDelivery && done)) {
      committing = true;
      await client.query("COMMIT");
      return { status: order.status };
    }
    if (pickup ? hasPickup || (!underway && order.status !== "assigned") : !hasPickup || !underway || hasDelivery) {
      fail(409, pickup ? "This order is no longer awaiting pickup." : "Record pickup proof before completing delivery.");
    }
    const { supabase } = require("../lib/supabase");
    upload = supabase.storage.from(bucket);
    path = "order-proofs/" + orderId + "/" + kind + "-" + randomUUID() + ".jpg";
    const stored = await upload.upload(path, photo, { contentType: "image/jpeg", cacheControl: "0", upsert: false });
    if (stored.error) fail(502, "Could not save the proof photo. Try again.");
    const changes = pickup
      ? "status = 'in_progress', pickup_at = now(), pickup_photo_taken = true, pickup_photo_url = $2"
      : "status = 'completed', delivered_at = now(), delivery_photo_taken = true, delivered_photo_url = $2";
    const result = await client.query("UPDATE public.orders SET " + changes + " WHERE id = $1 RETURNING status", [orderId, path]);
    committing = true;
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    const rolledBack = await client.query("ROLLBACK").then(() => true, () => false);
    if (path && !committing && rolledBack) await upload.remove([path]).catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function handleCourierProof(req, res, pool, pathname, json) {
  const match = route.exec(pathname);
  if (!match || req.method !== "POST") return false;
  res.setHeader("Cache-Control", "no-store");
  try {
    const access = await verifyDriverAccess(req);
    if (!access.email) fail(access.status, access.error);
    const result = await saveProof(pool, access.email, match[1].toLowerCase(), match[2].toLowerCase(), await readPhoto(req));
    json(res, 200, { ok: true, status: result.status });
  } catch (error) {
    if (!error.statusCode) console.error("[COURIER PROOF]", error.code || error.name);
    json(res, error.statusCode || 503, { error: error.statusCode ? error.message : "Could not record the proof. Try again." });
  }
  return true;
}

async function sendCourierProof(res, pool, orderId, kind) {
  if (!["pickup", "delivery"].includes(kind)) fail(400, "Choose pickup or delivery proof.");
  const column = kind === "pickup" ? "pickup_photo_url" : "delivered_photo_url";
  const { rows } = await pool.query(
    `SELECT ${column} AS path FROM public.orders
     WHERE id = $1 AND service_type = 'courier' AND (company_id = 1 OR company_id IS NULL)`, [orderId]
  );
  const path = rows[0]?.path;
  if (!path || !storagePath.test(path) || !path.startsWith("order-proofs/" + orderId + "/" + kind + "-")) {
    fail(404, "No private photo is available for this step.");
  }
  const { supabase } = require("../lib/supabase");
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error || !data) fail(502, "Could not load the proof photo. Try again.");
  res.statusCode = 200;
  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.end(Buffer.from(await data.arrayBuffer()));
}

module.exports = { handleCourierProof, sendCourierProof };
