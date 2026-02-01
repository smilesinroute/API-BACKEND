"use strict";

/**
 * Smiles in Route — Core API Router
 * =================================
 * - Plain Node.js HTTP routing (NO Express)
 * - Shared Postgres pool
 * - Customer + Admin + Driver routes
 */

const url = require("url");
const crypto = require("crypto");

/* ======================================================
   EXTERNAL HELPERS
====================================================== */
const { getDistanceMiles } = require("./src/lib/distanceMatrix");

/* ======================================================
   DRIVER ROUTES
====================================================== */
const { handleDriverRoutes } = require("./src/drivers/driverRoutes");
const { handleDriverOrders } = require("./src/drivers/driverOrders");
const { handleDriverAssignments } = require("./src/drivers/driverAssignments");
const { handleDriverProof } = require("./src/drivers/driverProof");

/* ======================================================
   ADMIN ROUTES
====================================================== */
const { handleAdminRoutes } = require("./src/admin/adminRoutes");

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
   BODY PARSING
====================================================== */
function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", chunk => {
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
  if (!type.includes("application/json")) {
    throw new Error("Content-Type must be application/json");
  }
  const raw = await readBody(req);
  return raw ? JSON.parse(raw) : {};
}

/* ======================================================
   VALIDATION HELPERS
====================================================== */
const str = v => String(v ?? "").trim();

function num(v, label) {
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(`${label} must be a number`);
  }
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
      slots.push(
        `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
      );
    }
  }
  return slots;
}

/* ======================================================
   MAIN API ROUTER
====================================================== */
async function handleAPI(req, res, pool) {
  const { pathname } = url.parse(req.url, true);
  const method = req.method;

  /* ---------- CORS ---------- */
  const origin = req.headers.origin;
  const allowedOrigins = [
    process.env.ADMIN_ORIGIN,
    "http://localhost:5174",
    "https://admin.smilesinroute.delivery",
  ].filter(Boolean);

  res.setHeader(
    "Access-Control-Allow-Origin",
    origin && allowedOrigins.includes(origin) ? origin : "*"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,OPTIONS"
  );

  if (method === "OPTIONS") return res.end();

  /* ======================================================
     DRIVER ROUTES
  ====================================================== */
  try {
    if (await handleDriverRoutes(req, res, pool, pathname, method)) return;
    if (await handleDriverOrders(req, res, pool, pathname, method)) return;
    if (await handleDriverAssignments(req, res, pool, pathname, method)) return;
    if (await handleDriverProof(req, res, pool, pathname, method)) return;
  } catch (err) {
    console.error("[DRIVER]", err);
    return json(res, 500, { error: "Driver routing error" });
  }

  /* ======================================================
     ADMIN ROUTES
  ====================================================== */
  try {
    if (await handleAdminRoutes(req, res, pool, pathname, method, json)) {
      return;
    }
  } catch (err) {
    console.error("[ADMIN]", err);
    return json(res, err.statusCode || 500, { error: err.message });
  }

  /* ======================================================
     HEALTH CHECK
  ====================================================== */
  if (pathname === "/api/health" && method === "GET") {
    try {
      await pool.query("SELECT 1");
      return json(res, 200, { status: "ok" });
    } catch {
      return json(res, 500, { status: "db_error" });
    }
  }

  /* ======================================================
     AVAILABLE TIME SLOTS
  ====================================================== */
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

  /* ======================================================
     DISTANCE
  ====================================================== */
  if (pathname === "/api/distance" && method === "POST") {
    try {
      const body = await readJson(req);
      if (!body.pickup || !body.delivery) {
        throw new Error("pickup and delivery required");
      }

      const miles = await getDistanceMiles(body.pickup, body.delivery);
      return json(res, 200, { distance_miles: miles });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  /* ======================================================
     QUOTE
  ====================================================== */
  if (pathname === "/api/quote" && method === "POST") {
    try {
      const body = await readJson(req);
      const miles = num(body.distance_miles, "distance_miles");

      const breakdown = {
        base: 25,
        mileage: Number((miles * 2.25).toFixed(2)),
        fragile: body.fragile ? 10 : 0,
        priority: body.priority ? 15 : 0,
        timeSensitive: body.timeSensitive ? 20 : 0,
      };

      const total = Object.values(breakdown).reduce((a, b) => a + b, 0);

      return json(res, 200, {
        quote_id: crypto.randomUUID(),
        breakdown,
        total,
      });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  /* ======================================================
     CONFIRM ORDER (CUSTOMER → DATABASE)
  ====================================================== */
  if (pathname === "/api/confirm" && method === "POST") {
    try {
      const body = await readJson(req);

      const pickup = str(body.pickup_address);
      const delivery = str(body.delivery_address);
      const email = str(body.customer_email);

      if (!pickup || !delivery) {
        throw new Error("pickup_address and delivery_address required");
      }

      if (!email) {
        throw new Error("customer_email required");
      }

      const total = num(body.total_amount, "total_amount");
      const miles = num(body.distance_miles, "distance_miles");
      const date = isoDate(body.scheduled_date);
      const time = hhmm(body.scheduled_time);

      const { rows } = await pool.query(
        `
        INSERT INTO orders (
          pickup_address,
          delivery_address,
          customer_email,
          service_type,
          distance_miles,
          total_amount,
          scheduled_date,
          scheduled_time,
          status
        )
        VALUES ($1,$2,$3,'courier',$4,$5,$6,$7,'confirmed_pending_payment')
        RETURNING id
        `,
        [pickup, delivery, email, miles, total, date, time]
      );

      return json(res, 201, {
        order_id: rows[0].id,
        status: "confirmed_pending_payment",
      });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  /* ======================================================
     ROOT
  ====================================================== */
  if (pathname === "/" && method === "GET") {
    return text(res, 200, "Smiles in Route API");
  }

  return json(res, 404, { error: "Not found" });
}

module.exports = { handleAPI };
