"use strict";

const { URL } = require("url");
const { createDriverSession } = require("../lib/driverAuth");

/* ======================================================
   RESPONSE HELPER
====================================================== */

function sendJSON(res, status, payload) {
  if (res.writableEnded) return;

  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

/* ======================================================
   BODY PARSER
====================================================== */

async function readJson(req) {
  let body = "";

  for await (const chunk of req) {
    body += chunk;
  }

  if (!body) return {};

  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

/* ======================================================
   DRIVER LOGIN ROUTE
   POST /api/driver/login
====================================================== */

async function handleDriverLogin(req, res, db) {

  const parsed = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsed.pathname || "/";
  const method = String(req.method || "GET").toUpperCase();

  if (pathname !== "/api/driver/login" || method !== "POST") {
    return false;
  }

  try {

    const body = await readJson(req);

    const email = String(body.email || "")
      .toLowerCase()
      .trim();

    if (!email) {
      return sendJSON(res, 400, {
        ok: false,
        error: "Email required"
      });
    }

    /* --------------------------------------------------
       Verify driver exists
    -------------------------------------------------- */

    const { rows } = await db.query(
      `
      SELECT id
      FROM drivers
      WHERE lower(email) = lower($1)
      LIMIT 1
      `,
      [email]
    );

    if (!rows.length) {
      return sendJSON(res, 404, {
        ok: false,
        error: "Driver not found"
      });
    }

    /* --------------------------------------------------
       Create session token
    -------------------------------------------------- */

    const token = await createDriverSession(db, rows[0].id);

    return sendJSON(res, 200, {
      ok: true,
      token
    });

  } catch (err) {

    console.error("[DRIVER] login error:", err);

    return sendJSON(res, 500, {
      ok: false,
      error: "Server error"
    });

  }
}

module.exports = { handleDriverLogin };