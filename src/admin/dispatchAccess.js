"use strict";

const { verifyCloudflareAccess } = require("../lib/driverAccess");

function accessError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

async function requireDispatchAdmin(req, subject, action) {
  const managers = String(process.env.ADMIN_DRIVER_MANAGER_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  const audience = String(process.env.ADMIN_ACCESS_AUDIENCE || "").trim();
  const driverAudience = String(process.env.DRIVER_ACCESS_AUDIENCE || "").trim();
  if (!managers.length || !audience || audience === driverAudience) {
    throw accessError(503, subject + " requires a separate Admin Access application.");
  }

  const access = await verifyCloudflareAccess(req, {
    issuer: process.env.ADMIN_ACCESS_ISSUER,
    audience,
  });
  if (!access.email) {
    const errors = {
      configuration: subject + " is awaiting Admin Access configuration.",
      unauthorized: "Sign in through the Admin Cloudflare application to " + action + ".",
      unavailable: "Admin access verification is temporarily unavailable.",
    };
    throw accessError(access.status, errors[access.reason]);
  }
  if (!managers.includes(access.email)) {
    throw accessError(403, "Your account does not have permission to " + action + ".");
  }
  return access.email;
}

module.exports = { requireDispatchAdmin };
