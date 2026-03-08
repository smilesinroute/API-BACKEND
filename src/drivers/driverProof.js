"use strict";

const crypto = require("crypto");
const { json, requireDriver } = require("../lib/driverAuth");
const { parseMultipart, fileToBuffer } = require("../lib/multipart");
const { uploadToStorage } = require("../lib/supabaseStorage");

/* ======================================================
   POST /api/driver/proof
   Upload pickup or delivery proof
====================================================== */

async function handleDriverProof(req, res, pool, pathname, method) {

  if (pathname !== "/api/driver/proof" || method !== "POST") {
    return false;
  }

  try {

    /* --------------------------------------------------
       Authenticate driver
    -------------------------------------------------- */

    const session = await requireDriver(pool, req, { requireSelfie: true });

    /* --------------------------------------------------
       Parse multipart request
    -------------------------------------------------- */

    const { fields, files } = await parseMultipart(req, {
      maxFileSize: 8 * 1024 * 1024
    });

    const orderId = String(fields.order_id || "").trim();
    const type = String(fields.type || "").trim().toLowerCase();
    const photo = files.file;

    if (!orderId || !type || !photo) {
      return json(res, 400, {
        ok: false,
        error: "order_id, type (pickup|delivery), and file are required"
      });
    }

    if (!["pickup", "delivery"].includes(type)) {
      return json(res, 400, {
        ok: false,
        error: "Invalid proof type"
      });
    }

    /* --------------------------------------------------
       Verify order exists and belongs to driver
    -------------------------------------------------- */

    const { rows } = await pool.query(
      `
      SELECT
        id,
        assigned_driver_id,
        status,
        pickup_photo_url,
        delivered_photo_url
      FROM orders
      WHERE id = $1
      LIMIT 1
      `,
      [orderId]
    );

    if (!rows.length) {
      return json(res, 404, {
        ok: false,
        error: "Order not found"
      });
    }

    const order = rows[0];

    if (order.assigned_driver_id !== session.driver_id) {
      return json(res, 403, {
        ok: false,
        error: "Order not assigned to this driver"
      });
    }

    /* --------------------------------------------------
       Prevent duplicate proofs
    -------------------------------------------------- */

    if (type === "pickup" && order.pickup_photo_url) {
      return json(res, 409, {
        ok: false,
        error: "Pickup proof already uploaded"
      });
    }

    if (type === "delivery" && order.delivered_photo_url) {
      return json(res, 409, {
        ok: false,
        error: "Delivery proof already uploaded"
      });
    }

    /* --------------------------------------------------
       Upload proof image
    -------------------------------------------------- */

    const buffer = await fileToBuffer(photo);

    const ext =
      (photo.originalFilename || "image.jpg")
        .split(".")
        .pop()
        .toLowerCase();

    const key = crypto.randomUUID();

    const storagePath =
      `orders/${orderId}/${type}_${key}.${ext}`;

    const uploaded = await uploadToStorage({
      bucket: "order-proofs",
      path: storagePath,
      buffer,
      contentType: photo.mimetype || "image/jpeg"
    });

    /* --------------------------------------------------
       Update order with proof
    -------------------------------------------------- */

    if (type === "pickup") {

      await pool.query(
        `
        UPDATE orders
        SET
          pickup_photo_url = $2,
          pickup_at = NOW(),
          status = 'picked_up'
        WHERE id = $1
        `,
        [orderId, uploaded.publicUrl]
      );

    } else {

      await pool.query(
        `
        UPDATE orders
        SET
          delivered_photo_url = $2,
          delivered_at = NOW(),
          status = 'completed'
        WHERE id = $1
        `,
        [orderId, uploaded.publicUrl]
      );

    }

    /* --------------------------------------------------
       Response
    -------------------------------------------------- */

    return json(res, 200, {
      ok: true,
      order_id: orderId,
      type,
      photo_url: uploaded.publicUrl
    });

  } catch (err) {

    console.error("[DRIVER] proof error:", err);

    return json(res, 500, {
      ok: false,
      error: err.message || "Server error"
    });

  }
}

module.exports = { handleDriverProof };