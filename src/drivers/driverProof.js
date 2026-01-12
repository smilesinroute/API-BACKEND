"use strict";

const crypto = require("crypto");
const { json, requireDriver } = require("../lib/driverAuth");
const { parseMultipart, fileToBuffer } = require("../lib/multipart");
const { uploadToStorage } = require("../lib/supabaseStorage");

/**
 * POST /api/driver/proof
 * multipart/form-data
 * Fields:
 * - order_id
 * - type = pickup | delivery
 * - file
 */
async function handleDriverProof(req, res, pool, pathname, method) {
  if (pathname !== "/api/driver/proof" || method !== "POST") {
    return false;
  }

  try {
    const session = await requireDriver(pool, req, { requireSelfie: true });

    const { fields, files } = await parseMultipart(req, {
      maxFileSize: 8 * 1024 * 1024,
    });

    const orderId = String(fields.order_id || "").trim();
    const type = String(fields.type || "").trim();
    const photo = files.file;

    if (!orderId || !type || !photo) {
      return json(res, 400, {
        error: "order_id, type (pickup|delivery), and file are required",
      });
    }

    if (!["pickup", "delivery"].includes(type)) {
      return json(res, 400, { error: "Invalid type" });
    }

    // Ensure order belongs to driver
    const { rows } = await pool.query(
      `
      SELECT id, assigned_driver_id
      FROM orders
      WHERE id = $1
      LIMIT 1
      `,
      [orderId]
    );

    if (!rows.length) {
      return json(res, 404, { error: "Order not found" });
    }

    if (rows[0].assigned_driver_id !== session.driver_id) {
      return json(res, 403, { error: "Order not assigned to this driver" });
    }

    // Upload photo
    const buffer = await fileToBuffer(photo);
    const ext = (photo.originalFilename || "jpg").split(".").pop();
    const key = crypto.randomUUID();

    const storagePath = `orders/${orderId}/${type}_${key}.${ext}`;

    const uploaded = await uploadToStorage({
      bucket: "order-proofs",
      path: storagePath,
      buffer,
      contentType: photo.mimetype || "image/jpeg",
    });

    // Update order
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
          status = 'delivered'
        WHERE id = $1
        `,
        [orderId, uploaded.publicUrl]
      );
    }

    return json(res, 200, {
      ok: true,
      order_id: orderId,
      type,
      photo_url: uploaded.publicUrl,
    });
  } catch (e) {
    console.error("[DRIVER] proof error:", e.message);
    return json(res, 400, { error: e.message });
  }
}

module.exports = { handleDriverProof };
