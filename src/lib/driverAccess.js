"use strict";

const { createPublicKey } = require("node:crypto");
const jwt = require("jsonwebtoken");

const keysByIssuer = new Map();

async function getAccessKeys(issuer) {
  const cached = keysByIssuer.get(issuer);
  if (cached && cached.expiresAt > Date.now()) return cached.keys;

  const response = await fetch(`${issuer}/cdn-cgi/access/certs`, {
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("Access keys unavailable");

  const { keys } = await response.json();
  if (!Array.isArray(keys) || keys.length === 0) throw new Error("Invalid Access keys");
  keysByIssuer.set(issuer, { keys, expiresAt: Date.now() + 60_000 });
  return keys;
}

async function verifyCloudflareAccess(req, config) {
  const issuer = String(config.issuer || "").trim();
  const audience = String(config.audience || "").trim();
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) || !audience) {
    return { status: 503, reason: "configuration" };
  }

  const unauthorized = { status: 401, reason: "unauthorized" };
  const token = req.headers["cf-access-jwt-assertion"];
  if (typeof token !== "string" || token.length > 8192) return unauthorized;

  const decoded = jwt.decode(token, { complete: true });
  const { alg, kid } = decoded?.header || {};
  if (alg !== "RS256" || typeof kid !== "string") return unauthorized;

  let keys;
  try {
    keys = await getAccessKeys(issuer);
  } catch {
    return { status: 503, reason: "unavailable" };
  }

  const jwk = keys.find((key) => key.kid === kid && key.kty === "RSA");
  if (!jwk) return unauthorized;

  try {
    const key = createPublicKey({ key: jwk, format: "jwk" });
    const claims = jwt.verify(token, key, { algorithms: ["RS256"], issuer, audience });
    const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
    if (!email || !Number.isFinite(claims.exp)) return unauthorized;
    return { email };
  } catch {
    return unauthorized;
  }
}

const driverAccessErrors = {
  configuration: "Driver job access is awaiting configuration.",
  unauthorized: "Sign in through Cloudflare Access to view your jobs.",
  unavailable: "Driver access verification is temporarily unavailable.",
};

async function verifyDriverAccess(req) {
  const access = await verifyCloudflareAccess(req, {
    issuer: process.env.DRIVER_ACCESS_ISSUER,
    audience: process.env.DRIVER_ACCESS_AUDIENCE,
  });
  if (access.email) return access;
  return { status: access.status, error: driverAccessErrors[access.reason] };
}

module.exports = { verifyCloudflareAccess, verifyDriverAccess };
