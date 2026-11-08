"use strict";

const { requireDispatchAdmin } = require("./dispatchAccess");
const { formatDriverCompanyId } = require("../lib/driverCompanyId");
const { allowDriverLogin, driverLoginListConfig } = require("./driverLoginList");
const { bucketName, photoPrefix, handleDriverRecordPhoto } = require("./driverRecordPhoto");

// The dispatch portal manages the Smiles In Route company in this database.
const companyId = 1;
const columns = "id, name, email, phone, vehicle_type, status, active, selfie_verified, driver_number::text AS driver_number";
const vehicles = new Set(["car", "cargo_van"]);
const driverIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const unusedDriver = `
  d.selfie_verified IS NOT TRUE
  AND d.selfie_image_url IS NULL
  AND d.last_selfie_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM orders WHERE assigned_driver_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM order_photos WHERE driver_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM driver_selfies WHERE driver_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM driver_locations WHERE driver_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM driver_sessions WHERE driver_id = d.id)
  AND NOT EXISTS (
    SELECT 1 FROM storage.objects
    WHERE bucket_id = '${bucketName}' AND name = '${photoPrefix}' || d.id::text || '.jpg'
  )
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

function rosterDriver({ driver_number, ...driver }) {
  return { ...driver, driver_code: formatDriverCompanyId(driver_number) };
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
  if (typeof id !== "string" || !driverIdPattern.test(id)) {
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
        await client.query(
          "UPDATE drivers SET active = true, status = CASE WHEN status = 'inactive' THEN 'offline' ELSE status END WHERE company_id = $1 AND id = $2",
          scope
        );
      } else {
        await client.query(
          "UPDATE drivers SET active = false, status = 'offline' WHERE company_id = $1 AND id = $2",
          scope
        );
        await client.query("DELETE FROM driver_sessions WHERE driver_id = $1", [id]);
        await client.query("DELETE FROM dispatch_private.driver_live_locations WHERE driver_id = $1", [id]);
      }
      const { rows } = await client.query(
        `SELECT ${rosterColumns} FROM drivers d WHERE company_id = $1 AND id = $2`,
        scope
      );
      result = { driver: rosterDriver(rows[0]) };
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
  await requireDispatchAdmin(req, "Driver management", "manage drivers");

  const params = new URL(req.url || "/admin/drivers", "http://localhost").searchParams;
  const photoId = params.get("photo");
  if (photoId !== null) {
    if (!driverIdPattern.test(photoId)) throw rosterError(400, "Select a valid driver.");
    return handleDriverRecordPhoto(req, res, pool, [companyId, photoId], method, json);
  }

  if (method === "GET" && params.get("tracking") === "1") {
    const { rows } = await pool.query(
      `SELECT l.driver_id, l.latitude, l.longitude, l.accuracy_m, l.event_at AS recorded_at
       FROM dispatch_private.driver_live_locations l
       JOIN public.drivers d ON d.id = l.driver_id
       WHERE d.company_id = $1 AND d.active IS TRUE AND d.status IS DISTINCT FROM 'inactive'
         AND l.latitude IS NOT NULL AND l.event_at >= now() - interval '2 minutes'`,
      [companyId]
    );
    return json(res, 200, { locations: rows });
  }

  if (method === "GET") {
    const { rows } = await pool.query(
      `SELECT ${rosterColumns} FROM drivers d WHERE company_id = $1 ORDER BY lower(name), id`,
      [companyId]
    );
    return json(res, 200, { drivers: rows.map(rosterDriver), login_setup_available: !!driverLoginListConfig() });
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
  return json(res, 201, { driver: { ...rosterDriver(rows[0]), open_jobs: 0, can_delete: true } });
}

module.exports = { handleDriverRoster };
