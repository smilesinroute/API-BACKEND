"use strict";

const { google } = require("googleapis");

const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = "Orders";

if (!SPREADSHEET_ID) {
  throw new Error("Missing GOOGLE_SHEET_ID env var");
}

const auth = new google.auth.JWT({
  email: process.env.GOOGLE_CLIENT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

/**
 * Initialize header row (run once safely)
 */
async function initSheetHeaders() {
  const headers = [
    "Order ID",
    "Service",
    "Date",
    "Time",
    "Customer Email",
    "Amount",
    "Status",
    "Stripe Session",
    "Driver",
    "Created At",
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A1:J1`,
    valueInputOption: "RAW",
    requestBody: {
      values: [headers],
    },
  });
}

/**
 * Append one order row (append-only)
 */
async function appendOrderRow(order) {
  const row = [
    order.order_id || "",
    order.service_type || "",
    order.date || "",
    order.time || "",
    order.customer_email || "",
    order.amount ?? "",
    order.status || "",
    order.stripe_session || "",
    order.driver || "",
    order.created_at || new Date().toISOString(),
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:J`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [row],
    },
  });
}

module.exports = {
  initSheetHeaders,
  appendOrderRow,
};
