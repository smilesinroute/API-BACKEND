"use strict";

const { requireDispatchAdmin } = require("./dispatchAccess");
const { verifyDriverAccess } = require("../lib/driverAccess");

const companyId = 1;
const contactTypes = new Set(["dispatch", "roadside", "insurance", "other"]);

async function readUpdate(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 16_384) return null;
    chunks.push(bytes);
  }
  try {
    const { revision, contacts } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!Number.isInteger(revision) || revision < 0 || revision > 2_147_483_647 ||
        !Array.isArray(contacts) || contacts.length > 12) return null;

    const normalized = [];
    for (const item of contacts) {
      const { kind, name, phone, coverage, notes } = item ?? {};
      if (!contactTypes.has(kind) || typeof name !== "string" || typeof phone !== "string" ||
          typeof coverage !== "string" || typeof notes !== "string") return null;
      if (!name.trim() || name.length > 80 || phone.length > 32 ||
          coverage.length > 100 || notes.length > 250 ||
          !/^\+?[0-9(). -]+$/.test(phone.trim())) return null;
      const dial = phone.trim().replace(/[(). -]/g, "");
      if (!/^\+?[0-9]{10,15}$/.test(dial)) return null;
      normalized.push({ kind, name: name.trim(), phone: dial, coverage: coverage.trim(), notes: notes.trim() });
    }
    return { revision, contacts: normalized };
  } catch {
    return null;
  }
}

async function handleDriverSupport(req, res, pool, pathname, json) {
  const admin = pathname === "/admin/driver-support";
  res.setHeader("Cache-Control", "no-store");

  try {
    if (req.method !== "GET" && !(admin && req.method === "PUT")) {
      res.setHeader("Allow", admin ? "GET, PUT" : "GET");
      return json(res, 405, { error: "Method not allowed." });
    }
    if (admin) {
      await requireDispatchAdmin(req, "Driver safety settings", "manage driver safety contacts");
    } else {
      const access = await verifyDriverAccess(req);
      if (!access.email) return json(res, access.status, { error: access.error });
      const { rows } = await pool.query(
        "SELECT company_id, active, status FROM public.drivers WHERE lower(email) = $1 LIMIT 2",
        [access.email]
      );
      if (rows.length !== 1 || rows[0].company_id !== companyId ||
          rows[0].active !== true || rows[0].status === "inactive") {
        return json(res, 403, { error: "This Cloudflare account is not registered as an active driver." });
      }
    }

    if (req.method === "GET") {
      const { rows: [directory] } = await pool.query(
        "SELECT revision, contacts FROM dispatch_private.driver_support WHERE company_id = $1",
        [companyId]
      );
      if (!directory) return json(res, 503, { error: "Driver safety contacts are temporarily unavailable." });
      return json(res, 200, admin ? directory : { contacts: directory.contacts });
    }

    if (req.headers["content-type"] !== "application/json") {
      return json(res, 415, { error: "Send the driver safety directory as JSON." });
    }
    const update = await readUpdate(req);
    if (!update) return json(res, 400, { error: "Enter valid contact names and full phone numbers. Up to 12 contacts are allowed." });
    const { rows: [saved] } = await pool.query(
      `UPDATE dispatch_private.driver_support
       SET contacts = $2, revision = revision + 1
       WHERE company_id = $1 AND revision = $3
       RETURNING revision, contacts`,
      [companyId, JSON.stringify(update.contacts), update.revision]
    );
    if (!saved) return json(res, 409, { error: "The directory changed. Reload the saved contacts before editing again." });
    return json(res, 200, saved);
  } catch (error) {
    if (error.statusCode) return json(res, error.statusCode, { error: error.message });
    console.error("[driver-support] directory unavailable", { code: error.code });
    return json(res, 503, { error: "Driver safety contacts are temporarily unavailable." });
  }
}

module.exports = { handleDriverSupport };
