// ======================================================
// Smiles in Route — Google Sheets Row Update System
// ======================================================

import { google } from "googleapis";
import path from "path";
import fs from "fs";

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

if (!SHEET_ID) {
  throw new Error("GOOGLE_SHEET_ID is not defined");
}

if (!KEY_PATH) {
  throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not defined");
}

const resolvedKeyPath = path.resolve(KEY_PATH);

if (!fs.existsSync(resolvedKeyPath)) {
  throw new Error("Google service account JSON file not found");
}

const auth = new google.auth.GoogleAuth({
  keyFile: resolvedKeyPath,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({
  version: "v4",
  auth,
});

const SHEET_TAB = "Orders"; // Make sure this tab exists

// ======================================================
// CREATE ORDER ROW (ONLY IF NOT EXISTS)
// ======================================================

export async function upsertOrderRow(order: {
  id: string;
  customer?: string;
  pickup_address?: string;
  delivery_address?: string;
  status: string;
  driver?: string;
}) {
  const existingRow = await findRowByOrderId(order.id);

  if (existingRow !== null) {
    await updateOrderStatus(order.id, order.status);
    return;
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A:F`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [
        [
          order.id,
          order.customer || "",
          order.pickup_address || "",
          order.delivery_address || "",
          order.status,
          order.driver || "",
        ],
      ],
    },
  });
}

// ======================================================
// UPDATE ORDER STATUS ONLY
// ======================================================

export async function updateOrderStatus(
  orderId: string,
  newStatus: string
) {
  const rowIndex = await findRowByOrderId(orderId);

  if (rowIndex === null) return;

  const rowNumber = rowIndex + 1;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!E${rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[newStatus]],
    },
  });
}

// ======================================================
// FIND ROW BY ORDER ID
// ======================================================

async function findRowByOrderId(orderId: string): Promise<number | null> {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A:A`,
  });

  const rows = response.data.values;

  if (!rows) return null;

  const index = rows.findIndex((row) => row[0] === orderId);

  return index === -1 ? null : index;
}