"use strict";

/**
 * ADMIN AUTH GUARD
 * =================
 * Protects admin / dispatch endpoints
 * - Expects: Authorization: Bearer <ADMIN_API_KEY>
 * - Throws structured errors for clean HTTP responses
 */

function requireAdmin(req) {
  const authHeader = req.headers?.authorization;

  if (!authHeader) {
    const err = new Error("Missing Authorization header");
    err.statusCode = 401;
    throw err;
  }

  if (!authHeader.startsWith("Bearer ")) {
    const err = new Error("Malformed Authorization header");
    err.statusCode = 401;
    throw err;
  }

  const token = authHeader.slice(7).trim();

  if (!process.env.ADMIN_API_KEY) {
    const err = new Error("Admin API key not configured on server");
    err.statusCode = 500;
    throw err;
  }

  if (token !== process.env.ADMIN_API_KEY) {
    const err = new Error("Invalid admin token");
    err.statusCode = 403;
    throw err;
  }

  // Authorized — continue
  return true;
}

module.exports = { requireAdmin };
