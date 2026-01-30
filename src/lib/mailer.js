"use strict";

const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

if (!process.env.RESEND_API_KEY) {
  throw new Error("Missing RESEND_API_KEY");
}

/**
 * Send email via Resend (HTTP, no SMTP)
 */
async function sendMail({ to, subject, text, html, replyTo }) {
  if (!to) throw new Error("Missing 'to' email");
  if (!subject) throw new Error("Missing email subject");

  try {
    return await resend.emails.send({
      from:
        process.env.MAIL_FROM ||
        "Smiles in Route <billing@smilesinroute.delivery>",
      to,
      subject,
      text,
      html,
      reply_to: replyTo,
    });
  } catch (err) {
    console.error("[RESEND] send failed:", err);
    throw err;
  }
}

module.exports = { sendMail };
