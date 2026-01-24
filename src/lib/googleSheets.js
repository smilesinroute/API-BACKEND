"use strict";

const { google } = require("googleapis");

/**
 * Append one order row to Google Sheets
 */
async function appendOrderRow(order) {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_CLIENT_EMAIL,
    null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    ["https://www.googleapis.com/auth/spreadsheets"]
  );

  const sheets = google.sheets({ version: "v4", auth });

  const values = [[
    order.id,
    order.service_type,
    order.scheduled_date || "",
    order.scheduled_time || "",
    order.customer_email || "",
    Number(order.total_amount || 0),
    order.status,
    order.stripe_session_id || "",
    order.driver_id || "",
    new Date().toISOString()
  ]];

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
    range: "Orders!A:J",
    valueInputOption: "RAW",
    requestBody: { values }
  });
}

module.exports = { appendOrderRow };
