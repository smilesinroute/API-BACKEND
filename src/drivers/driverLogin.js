"use strict";

const url = require("url");
const { createDriverSession } = require("../lib/driverAuth");

function sendJSON(res, status, data) {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => data += chunk);
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function handleDriverLogin(req, res, db) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || "/";
  const method = String(req.method || "GET").toUpperCase();

  if (pathname !== "/api/driver/login" || method !== "POST") {
    return false;
  }

  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw || "{}");
    const email = String(body.email || "").toLowerCase().trim();

    if (!email) {
      return sendJSON(res, 400, { error: "Email required" });
    }

    const { rows } = await db.query(
      `SELECT id FROM drivers WHERE lower(email) = lower($1) LIMIT 1`,
      [email]
    );

    if (!rows.length) {
      return sendJSON(res, 404, { error: "Driver not found" });
    }

    const token = await createDriverSession(db, rows[0].id);

    return sendJSON(res, 200, {
      ok: true,
      token
    });

  } catch (err) {
    console.error("Driver login error:", err);
    return sendJSON(res, 500, { error: "Server error" });
  }
}

module.exports = { handleDriverLogin };