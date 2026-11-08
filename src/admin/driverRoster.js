"use strict";

const { verifyCloudflareAccess } = require("../lib/driverAccess");

// The dispatch portal manages the Smiles In Route company in this database.
const companyId = 1;
const columns = "id, name, email, phone, vehicle_type, status, active";
const vehicles = new Set(["car", "cargo_van"]);

function rosterError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

async function requireRosterManager(req) {
  const managers = String(process.env.ADMIN_DRIVER_MANAGER_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  const audience = String(process.env.ADMIN_ACCESS_AUDIENCE || "").trim();
  const driverAudience = String(process.env.DRIVER_ACCESS_AUDIENCE || "").trim();
  if (!managers.length || !audience || audience === driverAudience) {
    throw rosterError(503, "Driver management requires a separate Admin Access application.");
  }

  const access = await verifyCloudflareAccess(req, {
    issuer: process.env.ADMIN_ACCESS_ISSUER,
    audience,
  });
  if (!access.email) {
    const errors = {
      configuration: "Driver management is awaiting Admin Access configuration.",
      unauthorized: "Sign in through the Admin Cloudflare application to manage drivers.",
      unavailable: "Admin access verification is temporarily unavailable.",
    };
    throw rosterError(access.status, errors[access.reason]);
  }
  if (!managers.includes(access.email)) {
    throw rosterError(403, "Your account does not have permission to manage drivers.");
  }
}

async function readDriver(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length <= 4096) chunks.push(bytes);
  }
  if (length > 4096) throw rosterError(413, "The driver form is too large.");

  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw rosterError(400, "Enter valid driver details.");
  }

  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const phone = typeof body?.phone === "string" ? body.phone.trim() : "";
  const vehicle = body?.vehicle_type;

  if (!name || name.length > 100) throw rosterError(400, "Enter a driver name up to 100 characters.");
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw rosterError(400, "Enter a valid Cloudflare sign-in email.");
  }
  if (phone.length > 32 || !/^\+?[\d(). -]+$/.test(phone) || !/^\d{7,15}$/.test(phone.replace(/\D/g, ""))) {
    throw rosterError(400, "Enter a valid driver phone number.");
  }
  if (!vehicles.has(vehicle)) throw rosterError(400, "Select a vehicle type.");

  return [name, email, phone, vehicle];
}

async function handleDriverRoster(req, res, pool, method, json) {
  res.setHeader("Cache-Control", "no-store");
  await requireRosterManager(req);

  if (method === "GET") {
    const { rows } = await pool.query(
      `SELECT ${columns} FROM drivers WHERE company_id = $1 ORDER BY lower(name), id`,
      [companyId]
    );
    return json(res, 200, { drivers: rows });
  }

  const fields = await readDriver(req);
  const { rows } = await pool.query(
    `INSERT INTO drivers (name, email, phone, vehicle_type, company_id, status, active, selfie_verified)
     SELECT $1, $2, $3, $4, $5, 'offline', false, false
     WHERE NOT EXISTS (SELECT 1 FROM drivers WHERE lower(email) = $2)
     ON CONFLICT (email) DO NOTHING
     RETURNING ${columns}`,
    [...fields, companyId]
  );
  if (!rows.length) throw rosterError(409, "A driver with this email already exists.");
  return json(res, 201, { driver: rows[0] });
}

module.exports = { handleDriverRoster };
