"use strict";

/**
 * ADMIN AUTH GUARD (MANUAL ROUTER)
 * ===============================
 * Designed for non-Express routing
 *
 * Expects:
 *   Authorization: Bearer <ADMIN_API_KEY>
 *
 * Returns:
 *   true  → authorized
 *   false → response already sent
 */

function requireAdmin(req, res, json) {
  const authHeader = req.headers?.authorization;

  if (!authHeader) {
    json(res, 401, { error: "Missing Authorization header" });
    return false;
  }

  if (!authHeader.startsWith("Bearer ")) {
    json(res, 401, { error: "Malformed Authorization header" });
    return false;
  }

  const token = authHeader.slice(7).trim();

  if (!process.env.ADMIN_API_KEY) {
    json(res, 500, {
      error: "Admin API key not configured on server",
    });
    return false;
  }

  if (token !== process.env.ADMIN_API_KEY.trim()) {
    json(res, 403, { error: "Invalid admin token" });
    return false;
  }

  // ✅ Authorized
  return true;
}

module.exports = { requireAdmin };
