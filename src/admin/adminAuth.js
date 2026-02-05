"use strict";

/**
 * Admin Auth Guard
 * ----------------
 * - NO response writing
 * - Throws on failure
 * - Caller decides how to respond
 */

function requireAdmin(req) {
  const header = String(req.headers.authorization || "");

  if (!header.startsWith("Bearer ")) {
    const err = new Error("Missing or invalid Authorization header");
    err.statusCode = 401;
    throw err;
  }

  const token = header.slice(7).trim();
  const expected = String(process.env.ADMIN_API_KEY || "");

  if (!expected || token !== expected) {
    const err = new Error("Unauthorized");
    err.statusCode = 403;
    throw err;
  }

  return true;
}

module.exports = { requireAdmin };
