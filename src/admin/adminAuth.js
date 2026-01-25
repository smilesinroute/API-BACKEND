"use strict";

/**
 * ADMIN AUTH GUARD
 * =================
 * Protects admin/dispatch endpoints
 */

function requireAdmin(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

  if (!token || token !== process.env.ADMIN_API_KEY) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }
}

module.exports = { requireAdmin };
