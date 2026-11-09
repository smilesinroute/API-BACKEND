"use strict";

const { createHash } = require("node:crypto");
const { requireDispatchAdmin } = require("./dispatchAccess");
const { formatDriverCompanyId } = require("../lib/driverCompanyId");

const companyId = 1;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const fields = `o.id, o.status, o.service_type, o.payment_status, o.customer_name,
  o.pickup_address, o.delivery_address, o.assigned_driver_id, o.created_at,
  o.scheduled_date::text, o.scheduled_time::text, o.pickup_at, o.delivered_at,
  d.name AS driver_name, d.driver_number::text, d.active AS driver_active,
  m.order_id IS NOT NULL AS entered_manually, b.number::text AS business_request_number`;

function fail(statusCode, message) {
  throw Object.assign(new Error(message), { statusCode });
}

async function readBody(req) {
  if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
    fail(415, "Send order details as JSON.");
  }
  const limit = 12288;
  const chunks = [];
  let size = 0;
  if (Number(req.headers["content-length"]) > limit) fail(413, "Order details are too large.");
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) fail(413, "Order details are too large.");
    chunks.push(bytes);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
    fail(400, "Enter valid order details.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) fail(400, "Enter valid order details.");
  return body;
}

function requiredId(value, label) {
  if (typeof value !== "string" || !uuid.test(value)) fail(400, "Choose a valid " + label + ".");
  return value.toLowerCase();
}

function field(value, label, max, required = true) {
  if (value == null && !required) return "";
  if (typeof value !== "string") fail(400, "Enter a valid " + label + ".");
  const result = value.trim();
  if ((required && !result) || result.length > max || result.includes("\0")) {
    fail(400, "Enter a valid " + label + ".");
  }
  return result;
}

async function orderRows(db, id = null) {
  const { rows } = await db.query(
    `SELECT ${fields}
       FROM public.orders o
       LEFT JOIN public.drivers d ON d.id = o.assigned_driver_id AND d.company_id = $1
       LEFT JOIN dispatch_private.manual_orders m ON m.order_id = o.id
       LEFT JOIN dispatch_private.business_requests b ON b.id = m.business_request_id AND b.company_id = $1
      WHERE (o.company_id = $1 OR o.company_id IS NULL) AND ($2::uuid IS NULL OR o.id = $2)
      ORDER BY o.created_at DESC NULLS LAST, o.id DESC`, [companyId, id]
  );
  return rows.map(row => ({ ...row, driver_code: formatDriverCompanyId(row.driver_number) }));
}

async function listBoard(pool) {
  const [orders, drivers] = await Promise.all([
    orderRows(pool),
    pool.query(`SELECT id, name, driver_number::text, vehicle_type FROM public.drivers
      WHERE company_id = $1 AND active IS TRUE ORDER BY lower(name), id`, [companyId]),
  ]);
  return { orders, drivers: drivers.rows.map(row => ({ ...row, driver_code: formatDriverCompanyId(row.driver_number) })) };
}

async function assignCourierOrder(pool, orderId, driverId) {
  orderId = requiredId(orderId, "order");
  driverId = requiredId(driverId, "driver");
  const { rows } = await pool.query(
    `UPDATE public.orders o
        SET assigned_driver_id = $2, status = 'assigned'
      WHERE o.id = $1 AND (o.company_id = $3 OR o.company_id IS NULL)
        AND o.service_type = 'courier' AND o.payment_status = 'paid'
        AND o.status IN ('paid', 'ready_for_dispatch') AND o.assigned_driver_id IS NULL
        AND EXISTS (SELECT 1 FROM public.drivers d
          WHERE d.id = $2 AND d.company_id = $3 AND d.active IS TRUE FOR SHARE)
      RETURNING o.id`, [orderId, driverId, companyId]
  );
  const [order] = await orderRows(pool, orderId);
  if (!order) fail(404, "Order not found.");
  if (!rows.length && (order.assigned_driver_id !== driverId ||
      !["assigned", "en_route", "in_progress"].includes(order.status))) {
    fail(409, "This order or driver is no longer available for assignment. Refresh the board.");
  }
  return order;
}

async function createManualOrder(pool, body, actor) {
  const id = requiredId(body.id, "order reference");
  const requestId = body.business_request_id ? requiredId(body.business_request_id, "business request") : null;
  const service = body.service_type;
  if (!["courier", "notary"].includes(service)) fail(400, "Choose courier or mobile notary.");
  const courier = service === "courier";
  const name = field(body.customer_name, "customer name", 160);
  const email = field(body.customer_email, "customer email", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, "Enter the email that should receive the payment link.");
  const phone = field(body.customer_phone, "phone number", 40, false);
  if (phone && phone.replace(/\D/g, "").length < 10) fail(400, "Enter a valid phone number.");
  const pickup = field(body.pickup_address, courier ? "pickup address" : "appointment address", 700);
  const delivery = courier ? field(body.delivery_address, "drop-off address", 700) : null;
  const notes = field(body.notes, "notes", 1800, false);
  const date = field(body.scheduled_date, "scheduled date", 10);
  const time = field(body.scheduled_time, "scheduled time", 5);
  const dateCheck = new Date(date + "T00:00:00Z");
  if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(dateCheck.getTime()) ||
      dateCheck.toISOString().slice(0, 10) !== date || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    fail(400, "Enter a valid scheduled date and time.");
  }

  const vehicle = courier ? body.vehicle_type : null;
  const price = courier ? field(body.total_amount, "agreed price", 9) : null;
  const documentType = courier ? null : field(body.document_type, "document type", 160);
  const signers = courier ? null : body.signers;
  const documents = courier ? null : body.documents;
  if (courier && (!["sedan", "cargo"].includes(vehicle) || !/^\d{1,6}(?:\.\d{1,2})?$/.test(price) || Number(price) <= 0)) {
    fail(400, "Choose a vehicle and enter a positive agreed price.");
  }
  if (!courier && (!Number.isInteger(signers) || signers < 1 || signers > 50 ||
      !Number.isInteger(documents) || documents < 1 || documents > 100)) {
    fail(400, "Enter 1–50 signers and 1–100 documents.");
  }

  const normalized = [service, name, email, phone, pickup, delivery, notes, date, time, vehicle, price, documentType, signers, documents, requestId];
  const digest = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (requestId) {
      const { rows } = await client.query(
        `SELECT kind, service_type FROM dispatch_private.business_requests
          WHERE id = $1 AND company_id = $2 AND status = 'accepted'`, [requestId, companyId]);
      if (!rows.length || ![service, "both"].includes(rows[0].service_type)) {
        fail(409, "Select an accepted business request that covers this service.");
      }
    }
    const orderNotes = [phone && "Customer phone: " + phone, notes].filter(Boolean).join("\n");
    const { rows } = await client.query(
      `INSERT INTO public.orders
        (id, company_id, region, service_type, customer_name, customer_email, pickup_address,
         delivery_address, scheduled_date, scheduled_time, vehicle_type, total_amount,
         document_type, signers, pricing_breakdown, notes, status, payment_status)
       VALUES ($1,$2,'oregon',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pending_admin_review','unpaid')
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [id, companyId, service, name, email, pickup, delivery, date, time, vehicle, price, documentType,
        signers, courier ? null : JSON.stringify({ quoteRequired: true, documents, signers }), orderNotes]);
    if (rows.length) {
      await client.query(
        `INSERT INTO dispatch_private.manual_orders (order_id, business_request_id, created_by, request_digest)
         VALUES ($1,$2,$3,$4)`, [id, requestId, actor, digest]);
    } else {
      const { rows: existing } = await client.query(
        "SELECT request_digest FROM dispatch_private.manual_orders WHERE order_id = $1", [id]);
      if (existing[0]?.request_digest !== digest) fail(409, "An order with that reference already exists. Refresh before trying again.");
    }
    const [order] = await orderRows(client, id);
    await client.query("COMMIT");
    return order;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function handleDispatchOrders(req, res, pool, parsed, json) {
  if (parsed.pathname !== "/admin/dispatch-orders") return false;
  res.setHeader("Cache-Control", "no-store");
  try {
    const actor = await requireDispatchAdmin(req, "Dispatch orders", "manage dispatch orders");
    if (req.method === "GET") json(res, 200, await listBoard(pool));
    else if (req.method === "POST") {
      const body = await readBody(req);
      if (body.action === "create") json(res, 201, { order: await createManualOrder(pool, body, actor) });
      else if (body.action === "assign") json(res, 200, { order: await assignCourierOrder(pool, body.order_id, body.driver_id) });
      else fail(400, "Choose a valid order action.");
    } else fail(405, "Method not allowed.");
  } catch (error) {
    if (!error.statusCode) console.error("[DISPATCH ORDERS]", error.code || error.name);
    json(res, error.statusCode || 503, { error: error.statusCode ? error.message : "Orders are temporarily unavailable. Try again shortly." });
  }
  return true;
}

module.exports = { handleDispatchOrders };
