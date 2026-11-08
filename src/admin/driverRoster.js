"use strict";

const { verifyCloudflareAccess } = require("../lib/driverAccess");
const { allowDriverLogin, driverLoginListConfig } = require("./driverLoginList");

// The dispatch portal manages the Smiles In Route company in this database.
const companyId = 1;
const columns = "id, name, email, phone, vehicle_type, status, active, selfie_verified";
const vehicles = new Set(["car", "cargo_van"]);
const unusedDriver = `
  d.selfie_verified IS NOT TRUE
  AND d.selfie_image_url IS NULL
  AND d.last_selfie_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM orders WHERE assigned_driver_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM order_photos WHERE driver_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM driver_selfies WHERE driver_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM driver_locations WHERE driver_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM driver_sessions WHERE driver_id = d.id)
`;
const rosterColumns = `
  ${columns},
  (${unusedDriver}) AS can_delete,
  (SELECT count(*)::int FROM orders
   WHERE assigned_driver_id = d.id
     AND status NOT IN ('completed', 'delivered', 'rejected', 'cancelled', 'canceled')) AS open_jobs
`;

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

async function readRosterBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length <= 4096) chunks.push(bytes);
  }
  if (length > 4096) throw rosterError(413, "The driver form is too large.");

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw rosterError(400, "Enter valid driver details.");
  }
}

async function readDriver(req) {
  const body = await readRosterBody(req);
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

async function updateDriver(req, pool, method) {
  const { id } = (await readRosterBody(req)) ?? {};
  if (typeof id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) {
    throw rosterError(400, "Select a valid driver.");
  }

  const config = method === "PUT" ? driverLoginListConfig() : null;
  if (method === "PUT" && !config) {
    throw rosterError(503, "Driver login needs its one-time Cloudflare setup.");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const scope = [companyId, id];
    // Serialize changes to the same driver, including Cloudflare provisioning.
    const driver = await client.query(
      "SELECT id, email FROM drivers WHERE company_id = $1 AND id = $2 FOR UPDATE",
      scope
    );
    if (!driver.rowCount) throw rosterError(404, "Driver not found.");

    let result;
    if (method === "DELETE") {
      const deleted = await client.query(
        `DELETE FROM drivers d WHERE company_id = $1 AND id = $2 AND (${unusedDriver}) RETURNING id`,
        scope
      );
      if (!deleted.rowCount) {
        throw rosterError(409, "This driver has activity on file. Remove access to preserve their history.");
      }
      result = { id: deleted.rows[0].id };
    } else {
      if (method === "PUT") {
        const email = driver.rows[0].email?.trim().toLowerCase() ?? "";
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          throw rosterError(409, "This driver needs a valid sign-in email.");
        }
        await allowDriverLogin(config, email);
        await client.query("UPDATE drivers SET active = true WHERE company_id = $1 AND id = $2", scope);
      } else {
        await client.query(
          "UPDATE drivers SET active = false, status = 'offline' WHERE company_id = $1 AND id = $2",
          scope
        );
        await client.query("DELETE FROM driver_sessions WHERE driver_id = $1", [id]);
      }
      const { rows } = await client.query(
        `SELECT ${rosterColumns} FROM drivers d WHERE company_id = $1 AND id = $2`,
        scope
      );
      result = { driver: rows[0] };
    }
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function handleDriverRoster(req, res, pool, method, json) {
  res.setHeader("Cache-Control", "no-store");
  await requireRosterManager(req);

  if (method === "GET") {
    const { rows } = await pool.query(
      `SELECT ${rosterColumns} FROM drivers d WHERE company_id = $1 ORDER BY lower(name), id`,
      [companyId]
    );
    return json(res, 200, { drivers: rows, login_setup_available: !!driverLoginListConfig() });
  }

  if (method === "PUT" || method === "PATCH" || method === "DELETE") {
    return json(res, 200, await updateDriver(req, pool, method));
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
  return json(res, 201, { driver: { ...rows[0], open_jobs: 0, can_delete: true } });
}

module.exports = { handleDriverRoster };
