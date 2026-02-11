"use strict";

const express = require("express");

const pool = require("../../shared/db"); // shared db.js (optional read-only)
const config = require("../../shared/config"); // shared config.js
const { generateToken, verifyToken } = require("../../shared/auth");
const { logError, logInfo } = require("../../shared/utils");
const { USER_ROLES, DELIVERY_STATUS } = require("../../shared/constants");

const app = express();

/* ======================================================
   MIDDLEWARE
====================================================== */
app.use(express.json({ limit: "1mb" }));

/* ======================================================
   HEALTH / ROOT
====================================================== */
app.get("/", (_req, res) => res.status(200).send("✅ api portal running"));

app.get("/health", async (_req, res) => {
  try {
    // Optional: remove if you truly don't want DB touched here
    await pool.query("SELECT 1");
    return res.status(200).json({ ok: true });
  } catch (err) {
    logError("[health] db check failed", err);
    return res.status(500).json({ ok: false, error: "db_error" });
  }
});

/* ======================================================
   START
====================================================== */
const PORT = Number(config.PORT || process.env.PORT || 3001);

app.listen(PORT, () => {
  logInfo(`API portal listening on port ${PORT}`);
});

/* ======================================================
   EXPORTS (optional, helps testing)
====================================================== */
module.exports = { app };

