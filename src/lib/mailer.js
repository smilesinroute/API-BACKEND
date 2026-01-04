"use strict";

const nodemailer = require("nodemailer");

let cachedTransport = null;

/**
 * Create or reuse SMTP transport
 */
function getTransport() {
  if (cachedTransport) return cachedTransport;

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const secure = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";

  if (!host || !user || !pass) {
    throw new Error("Missing SMTP settings (SMTP_HOST / SMTP_USER / SMTP_PASS)");
  }

  cachedTransport = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    pool: true,               // ✅ reuse connection
    maxConnections: 3,
    maxMessages: 100,
  });

  return cachedTransport;
}

/**
 * Send email (text + optional HTML)
 */
async function sendMail({ to, subject, text, html, replyTo }) {
  if (!to) throw new Error("Missing 'to' email");
  if (!subject) throw new Error("Missing email subject");

  const transport = getTransport();

  const from =
    process.env.MAIL_FROM ||
    `"Smiles in Route" <${process.env.SMTP_USER}>`;

  try {
    return await transport.sendMail({
      from,
      to,
      subject,
      text,
      html,
      replyTo: replyTo || process.env.MAIL_REPLY_TO || undefined,
    });
  } catch (err) {
    console.error("[MAILER] send failed:", err.message);
    throw err;
  }
}

module.exports = { sendMail };
