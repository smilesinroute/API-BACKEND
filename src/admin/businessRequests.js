"use strict";

const { requireDispatchAdmin } = require("./dispatchAccess");
const { readSheetStatus, syncBusinessRequestSheet } = require("./businessRequestSheet");

const table = "dispatch_private.business_requests";
const companyId = 1;
const pageSize = 25;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const fields = `id, number::text, kind, source, company, contact_name, email, phone, details,
  service_area, requested_date::text, stop_count, service_type, frequency, expected_volume,
  status, quote_cents, quote_terms, quoted_at, accepted_at, acceptance_note,
  activity, version, created_at, updated_at`;

function fail(statusCode, message) {
  throw Object.assign(new Error(message), { statusCode });
}

async function readBody(req) {
  if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
    fail(415, "Send request details as JSON.");
  }
  const limit = 12288;
  if (Number(req.headers["content-length"]) > limit) fail(413, "The request is too large.");
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) fail(413, "The request is too large.");
    chunks.push(bytes);
  }

  let result;
  try {
    result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    fail(400, "Enter valid request details.");
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) fail(400, "Enter valid request details.");
  return result;
}

function textField(value, label, limit, required = true) {
  if (value == null && !required) return null;
  const text = typeof value === "string" ? value.trim() : "";
  if ((required && !text) || text.length > limit || text.includes("\0") || typeof value !== "string") {
    fail(400, label + " must be " + (required ? "filled in and " : "") + limit + " characters or fewer.");
  }
  return text || null;
}

function requestDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) {
    fail(400, "Choose a valid requested date.");
  }
  const date = new Date(value + "T00:00:00Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    fail(400, "Choose a valid requested date.");
  }
  return value;
}

function reference(number) {
  return "BR-" + String(number).padStart(4, "0");
}

async function submit(req, res, pool, json, actor = null) {
  const body = await readBody(req);
  if (typeof body.id !== "string" || !uuid.test(body.id) || !["bulk", "contract"].includes(body.kind) || body.website) {
    fail(400, "Enter valid request details.");
  }
  const company = textField(body.company, "Company name", 120);
  const contact = textField(body.contact_name, "Contact name", 100);
  const email = textField(body.email, "Email", 254, !actor)?.toLowerCase() ?? "";
  const phone = textField(body.phone, "Phone", 32, false);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, "Enter a valid email address.");
  if (actor && !email && !phone) fail(400, "Enter an email address or phone number.");
  const details = textField(body.details, "Request details", 2000);
  const bulk = body.kind === "bulk";
  const serviceType = bulk ? "courier" : body.service_type;
  if (!["courier", "notary", "both"].includes(serviceType)) fail(400, "Select the service you need.");
  if (bulk && (!Number.isInteger(body.stop_count) || body.stop_count < 2 || body.stop_count > 10000)) {
    fail(400, "Enter a stop count from 2 to 10,000.");
  }

  const values = [
    body.id, companyId, body.kind, company, contact, email, phone, details,
    bulk ? textField(body.service_area, "Pickup and delivery area", 150) : null,
    bulk ? requestDate(body.requested_date) : null, bulk ? body.stop_count : null, serviceType,
    bulk ? null : textField(body.frequency, "Service schedule", 150),
    bulk ? null : textField(body.expected_volume, "Expected volume", 100),
    actor ? "manual" : "public", actor,
  ];
  const { rows } = await pool.query(
    `INSERT INTO ${table} AS existing
      (id, company_id, kind, company, contact_name, email, phone, details, service_area,
        requested_date, stop_count, service_type, frequency, expected_volume, source, updated_by, activity)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
        CASE WHEN $16::text IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(jsonb_build_object(
          'status', 'new', 'recorded_at', now(), 'recorded_by', $16::text, 'quote_cents', NULL
        )) END)
      ON CONFLICT (id) DO UPDATE SET id = existing.id
        WHERE (existing.company_id, existing.kind, existing.company, existing.contact_name,
          existing.email, existing.phone, existing.details, existing.service_area,
          existing.requested_date, existing.stop_count, existing.service_type,
          existing.frequency, existing.expected_volume, existing.source)
        IS NOT DISTINCT FROM (EXCLUDED.company_id, EXCLUDED.kind, EXCLUDED.company,
          EXCLUDED.contact_name, EXCLUDED.email, EXCLUDED.phone, EXCLUDED.details,
          EXCLUDED.service_area, EXCLUDED.requested_date, EXCLUDED.stop_count,
          EXCLUDED.service_type, EXCLUDED.frequency, EXCLUDED.expected_volume, EXCLUDED.source)
      RETURNING ${fields}`,
    values
  );
  if (!rows.length) fail(409, "These details changed after the request was submitted. Start a new request if needed.");
  const receipt = { reference: reference(rows[0].number) };
  return json(res, 201, actor ? { ...receipt, request: rows[0] } : receipt);
}

const transitions = {
  reviewing: ["new"],
  quoted: ["new", "reviewing", "quoted"],
  accepted: ["quoted"],
  declined: ["new", "reviewing", "quoted"],
};

async function update(req, res, pool, json, actor) {
  const body = await readBody(req);
  const { id, status, version } = body;
  if (typeof id !== "string" || !uuid.test(id) || !Number.isInteger(version) ||
      version < 1 || version >= 2147483647 || typeof status !== "string" || !Object.hasOwn(transitions, status)) {
    fail(400, "Enter a valid request update.");
  }
  const cents = status === "quoted" ? body.quote_cents : null;
  if (status === "quoted" && (!Number.isInteger(cents) || cents < 0 || cents > 99999999)) {
    fail(400, "Enter a valid quote amount.");
  }
  const terms = status === "quoted" ? textField(body.quote_terms, "Quote terms", 2000) : null;
  const acceptance = status === "accepted" ? textField(body.acceptance_note, "Customer acceptance note", 500) : null;

  const { rows } = await pool.query(
    `UPDATE ${table} SET
       status = $3, version = version + 1, updated_at = now(), updated_by = $4,
       quote_cents = COALESCE($5, quote_cents), quote_terms = COALESCE($6, quote_terms),
       quoted_at = CASE WHEN $3 = 'quoted' THEN now() ELSE quoted_at END,
       accepted_at = CASE WHEN $3 = 'accepted' THEN now() ELSE accepted_at END,
       acceptance_note = COALESCE($7, acceptance_note),
       activity = activity || jsonb_build_array(jsonb_build_object(
         'status', $3::text, 'recorded_at', now(), 'recorded_by', $4::text,
         'quote_cents', $5::integer, 'quote_terms', $6::text, 'acceptance_note', $7::text
       ))
     WHERE company_id = $1 AND id = $2 AND version = $8 AND status = ANY($9::text[])
     RETURNING ${fields}`,
    [companyId, id, status, actor, cents, terms, acceptance, version, transitions[status]]
  );
  if (!rows.length) fail(409, "This request changed or can no longer be updated. Reload the inbox.");
  return json(res, 200, { request: rows[0] });
}

async function list(res, pool, json, params) {
  const id = params.get("id");
  if (id !== null) {
    if (!uuid.test(id)) fail(400, "Choose a valid business request.");
    const { rows } = await pool.query(
      `SELECT ${fields} FROM ${table} WHERE company_id = $1 AND id = $2`, [companyId, id]
    );
    return json(res, 200, { requests: rows, next_before: null });
  }
  const view = params.get("view") ?? "open";
  const before = params.get("before");
  const statuses = view === "open" ? ["new", "reviewing", "quoted"] : view === "closed" ? ["accepted", "declined"] : null;
  if (!statuses || (before !== null && (!/^[1-9]\d{0,18}$/.test(before) || BigInt(before) > 9223372036854775807n))) {
    fail(400, "Choose a valid inbox view.");
  }
  const { rows } = await pool.query(
    `SELECT ${fields} FROM ${table} AS requests
     WHERE company_id = $1 AND status = ANY($2::text[]) AND ($3::bigint IS NULL OR number < $3)
     ORDER BY requests.number DESC LIMIT $4`,
    [companyId, statuses, before, pageSize + 1]
  );
  const requests = rows.slice(0, pageSize);
  return json(res, 200, { requests, next_before: rows.length > pageSize ? requests.at(-1).number : null });
}

async function handleBusinessRequests(req, res, pool, parsed, json) {
  const publicRoute = parsed.pathname === "/api/business-requests";
  if (!publicRoute && parsed.pathname !== "/admin/business-requests") return false;

  res.setHeader("Cache-Control", "no-store");
  try {
    if (publicRoute && req.method === "POST") {
      await submit(req, res, pool, json);
    } else if (!publicRoute && ["GET", "POST", "PATCH"].includes(req.method)) {
      const actor = await requireDispatchAdmin(req, "Business requests", "manage business requests");
      if (parsed.searchParams.get("sheets") === "1") {
        if (req.method === "GET") json(res, 200, await readSheetStatus(pool));
        else if (req.method === "POST") json(res, 200, await syncBusinessRequestSheet(pool, await readBody(req)));
        else json(res, 405, { error: "Method not allowed." });
      } else if (req.method === "GET") await list(res, pool, json, parsed.searchParams);
      else if (req.method === "POST") await submit(req, res, pool, json, actor);
      else await update(req, res, pool, json, actor);
    } else {
      json(res, 405, { error: "Method not allowed." });
    }
  } catch (error) {
    if (!error.statusCode) console.error("[BUSINESS REQUESTS]", error.code || error.name);
    json(res, error.statusCode || 503, { error: error.statusCode ? error.message : "Business requests are temporarily unavailable. Try again shortly." });
  }
  return true;
}

module.exports = { handleBusinessRequests };
