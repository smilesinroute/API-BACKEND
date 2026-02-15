/**
 * src/drivers/driverRoutes.js
 *
 * Production-hardened Driver Routes
 * - Cloudflare Access auto-login (header-based)
 * - Manual email/password login (bcrypt + legacy fallback)
 * - JWT session tokens
 * - Driver orders fetching (Bearer token)
 *
 * Requires:
 *   npm install bcrypt jsonwebtoken
 *
 * ENV:
 *   JWT_SECRET=strong_secret_here
 *   DRIVER_JWT_EXPIRES_IN=12h (optional)
 */

"use strict";

const url = require("url");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("Missing required env: JWT_SECRET");
}

const JWT_EXPIRES_IN = process.env.DRIVER_JWT_EXPIRES_IN || "12h";

/* --------------------------------------------------
   Helpers
-------------------------------------------------- */

function sendJSON(res, status, data) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function normalizeEmail(v) {
  return String(v || "").trim().toLowerCase();
}

function createDriverToken(driver) {
  return jwt.sign(
    {
      id: driver.id,
      email: driver.email,
      role: "driver",
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function readRequestBody(req, { maxBytes = 1024 * 64 } = {}) {
  return new Promise((resolve) => {
    let body = "";
    let bytes = 0;
    let done = false;

    req.on("data", (chunk) => {
      if (done) return;
      bytes += chunk.length;

      if (bytes > maxBytes) {
        done = true;
        try {
          req.destroy();
        } catch {}
        return resolve({ __tooLarge: true });
      }

      body += chunk.toString("utf8");
    });

    req.on("end", () => {
      if (done) return;
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve({ __invalidJson: true });
      }
    });

    req.on("error", () => resolve({ __readError: true }));
  });
}

function getCloudflareEmail(req) {
  const v =
    req.headers["cf-access-authenticated-user-email"] ||
    req.headers["x-cf-access-authenticated-user-email"];
  return normalizeEmail(v);
}

function extractDriverFromToken(req) {
  const auth = String(req.headers.authorization || "");

  if (!auth.toLowerCase().startsWith("bearer ")) {
    return { error: "Missing Authorization token" };
  }

  const token = auth.slice(7).trim();
  if (!token) return { error: "Missing Authorization token" };

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return { payload };
  } catch {
    return { error: "Invalid token" };
  }
}

/* --------------------------------------------------
   DB helpers
-------------------------------------------------- */

async function findDriverByEmail(db, email) {
  const { rows } = await db.query(
    `
    SELECT id, email, password, active, status
    FROM drivers
    WHERE lower(email) = lower($1)
    LIMIT 1
    `,
    [email]
  );
  return rows[0] || null;
}

/* --------------------------------------------------
   Route Handlers
-------------------------------------------------- */

async function handleDriverLogin(req, res, db) {
  try {
    const cfEmail = getCloudflareEmail(req);

    // Cloudflare Access auto-login
    if (cfEmail) {
      const driver = await findDriverByEmail(db, cfEmail);

      if (!driver || driver.active === false || driver.status === "inactive") {
        return sendJSON(res, 403, { error: "Driver not authorized" });
      }

      const token = createDriverToken({
        id: driver.id,
        email: driver.email,
      });

      return sendJSON(res, 200, {
        ok: true,
        token,
        driver: {
          id: driver.id,
          email: driver.email,
        },
      });
    }

    // Manual login fallback
    const body = await readRequestBody(req);

    if (body.__tooLarge) {
      return sendJSON(res, 413, { error: "Request body too large" });
    }
    if (body.__invalidJson) {
      return sendJSON(res, 400, { error: "Invalid JSON body" });
    }

    const email = normalizeEmail(body.email);
    const password = String(body.password || "");

    if (!email || !password) {
      return sendJSON(res, 400, { error: "Email and password required" });
    }

    const driver = await findDriverByEmail(db, email);

    // Do not reveal whether email exists
    if (!driver || driver.active === false || driver.status === "inactive") {
      return sendJSON(res, 401, { error: "Invalid credentials" });
    }

    const stored = String(driver.password || "");
    let ok = false;

    if (stored.startsWith("$2")) {
      // bcrypt hash
      ok = await bcrypt.compare(password, stored);
    } else {
      // legacy plaintext fallback
      ok = password === stored;
    }

    if (!ok) {
      return sendJSON(res, 401, { error: "Invalid credentials" });
    }

    const token = createDriverToken({
      id: driver.id,
      email: driver.email,
    });

    return sendJSON(res, 200, {
      ok: true,
      token,
      driver: {
        id: driver.id,
        email: driver.email,
      },
    });
  } catch (err) {
    console.error("[DRIVER LOGIN ERROR]", err);
    return sendJSON(res, 500, { error: "Login failed" });
  }
}

async function handleDriverOrders(req, res, db) {
  try {
    const { payload, error } = extractDriverFromToken(req);

    if (!payload) {
      return sendJSON(res, 401, { error: error || "Unauthorized" });
    }

    if (!payload.id || payload.role !== "driver") {
      return sendJSON(res, 403, { error: "Forbidden" });
    }

    const { rows } = await db.query(
      `
      SELECT id, customer, address, status, service_type
      FROM orders
      WHERE driver_id = $1
      ORDER BY id DESC
      `,
      [payload.id]
    );

    return sendJSON(res, 200, {
      ok: true,
      orders: rows,
    });
  } catch (err) {
    console.error("[DRIVER ORDERS ERROR]", err);
    return sendJSON(res, 500, { error: "Failed to fetch driver orders" });
  }
}

/* --------------------------------------------------
   Main Router
-------------------------------------------------- */

async function handleDriverRoutes(req, res, db) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const method = req.method;

  if (pathname === "/api/driver/login" && method === "POST") {
    await handleDriverLogin(req, res, db);
    return true;
  }

  if (pathname === "/api/driver/orders" && method === "GET") {
    await handleDriverOrders(req, res, db);
    return true;
  }

  return false;
}

module.exports = { handleDriverRoutes };
