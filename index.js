"use strict";

/**
 * Smiles in Route — Core API Router
 * =================================
 * Plain Node.js HTTP routing (NO Express)
 * Shared Supabase Postgres pool
 */

const url = require("url");
const crypto = require("crypto");

/* ======================================================
   DRIVER ROUTES (PRIORITY)
====================================================== */
const { handleDriverRoutes } = require("./src/drivers/driverRoutes");
const { handleDriverOrders } = require("./src/drivers/driverOrders");
const { handleDriverAssignments } = require("./src/drivers/driverAssignments");
const { handleDriverProof } = require("./src/drivers/driverProof");

/* ======================================================
   RESPONSE HELPERS
====================================================== */
function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function text(res, status, message) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(message);
}

/* ======================================================
   BODY PARSING (RAW NODE)
====================================================== */
function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () =>
      resolve(Buffer.concat(chunks).toString("utf8"))
    );
    req.on("error", reject);
  });
}

async function readJson(req) {
  const type = String(req.headers["content-type"] || "");
  if (type && !type.includes("application/json")) {
    throw new Error("Content-Type must be application/json");
  }

  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

/* ======================================================
   VALIDATION
====================================================== */
const str = (v) => String(v ?? "").trim();

function num(v, label) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${label} must be a number`);
  return n;
}

function isoDate(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new Error("date must be YYYY-MM-DD");
  }
  return v;
}

function hhmm(v) {
  if (!/^\d{2}:\d{2}$/.test(v)) {
    throw new Error("time must be HH:MM");
  }
  return v;
}

/* ======================================================
   SCHEDULING HELPERS
====================================================== */
function generateTimeSlots() {
  const slots = [];
  for (let h = 8; h < 18; h++) {
    for (let m = 0; m < 60; m += 30) {
      slots.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
  }
  return slots;
}

/* ======================================================
   MAIN ROUTER
====================================================== */
async function handleAPI(req, res, pool) {
  const { pathname } = url.parse(req.url, true);
  const method = req.method;

  /* ---------- CORS ---------- */
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (method === "OPTIONS") return res.end();

  /* ---------- DRIVER ROUTES ---------- */
  try {
    if (await handleDriverRoutes(req, res, pool, pathname, method)) return;
    if (await handleDriverOrders(req, res, pool, pathname, method)) return;
    if (await handleDriverAssignments(req, res, pool, pathname, method)) return;
    if (await handleDriverProof(req, res, pool, pathname, method)) return;
  } catch (err) {
    console.error("[DRIVER]", err.message);
    return json(res, 500, { error: "Driver routing error" });
  }

  /* ---------- HEALTH ---------- */
  if (pathname === "/api/health" && method === "GET") {
    try {
      await pool.query("SELECT 1");
      return json(res, 200, { status: "ok" });
    } catch {
      return json(res, 500, { status: "db_error" });
    }
  }

  /* ---------- AVAILABLE SLOTS ---------- */
  if (pathname.startsWith("/api/available-slots/") && method === "GET") {
    try {
      const date = isoDate(pathname.split("/").pop());
      return json(res, 200, {
        date,
        availableSlots: generateTimeSlots(),
      });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  /* ---------- DISTANCE ---------- */
  if (pathname === "/api/distance" && method === "POST") {
    try {
      const body = await readJson(req);
      if (!body.pickup || !body.delivery) {
        throw new Error("pickup and delivery required");
      }

      // TEMP placeholder
      return json(res, 200, { distance_miles: 12.4 });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  /* ---------- QUOTE ---------- */
  if (pathname === "/api/quote" && method === "POST") {
    try {
      const body = await readJson(req);

      const miles = num(body.distance_miles, "distance_miles");

      const breakdown = {
        base: 25,
        mileage: miles * 2.25,
        fragile: body.fragile ? 10 : 0,
        priority: body.priority ? 15 : 0,
      };

      const total = Object.values(breakdown).reduce((a, b) => a + b, 0);

      return json(res, 200, {
        quote_id: crypto.randomUUID(),
        breakdown,
        total: Number(total.toFixed(2)),
      });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  /* ---------- CONFIRM ORDER (THIS FIXES FINALIZE) ---------- */
  if (pathname === "/api/confirm" && method === "POST") {
    try {
      const body = await readJson(req);

      const pickup = str(body.pickup_address);
      const delivery = str(body.delivery_address);
      const date = isoDate(body.scheduled_date);
      const time = hhmm(body.scheduled_time);
      const total = num(body.total_amount, "total_amount");

      if (!pickup || !delivery) {
        throw new Error("pickup_address and delivery_address required");
      }

      const { rows } = await pool.query(
        `
        INSERT INTO orders (
          pickup_address,
          delivery_address,
          service_type,
          total_amount,
          scheduled_date,
          scheduled_time,
          status
        )
        VALUES ($1,$2,'courier',$3,$4,$5,'confirmed_pending_payment')
        RETURNING id
        `,
        [pickup, delivery, total, date, time]
      );

      return json(res, 201, {
        order_id: rows[0].id,
        status: "confirmed_pending_payment",
      });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  /* ---------- ROOT ---------- */
  if (pathname === "/" && method === "GET") {
    return text(res, 200, "Smiles in Route API");
  }

  return json(res, 404, { error: "Not found" });
}

module.exports = { handleAPI };
