"use strict";

const { formatDriverCompanyId } = require("../lib/driverCompanyId");
const { bucketName, photoPrefix } = require("./driverRecordPhoto");

const table = "dispatch_private.business_request_sheet";
const title = "Business Requests";
const headers = [
  "Smiles In Route Request ID", "Source", "Request type", "Status", "Received (UTC)",
  "Requested date", "Stops", "Quote (USD)", "Accepted (UTC)", "Updated (UTC)",
];
const photoHeaders = ["Driver ID", "Driver name", "Private selfie"];
const adminPhotoUrl = "https://admin.smilesinroute.delivery/.netlify/functions/admin-drivers";
const maxRows = 10000;
const options = { timeout: 5000, retry: false };

function fail(statusCode, message) {
  throw Object.assign(new Error(message), { statusCode });
}

function credentials() {
  const email = process.env.GOOGLE_CLIENT_EMAIL?.trim();
  const key = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  return email && key ? { email, key } : null;
}

function status(row) {
  return {
    spreadsheet_id: row.spreadsheet_id,
    synced_at: row.synced_at,
    pending: !!row.spreadsheet_id && row.revision !== row.synced_revision,
    service_account: credentials()?.email ?? null,
  };
}

async function readConfig(db) {
  const { rows } = await db.query(
    `SELECT spreadsheet_id, revision, synced_revision, synced_at FROM ${table} WHERE company_id = 1`
  );
  return rows[0];
}

async function readSheetStatus(pool) {
  return status(await readConfig(pool));
}

async function driverPhotoRequests(db, sheets, spreadsheetId, tab) {
  // A matching header opts the connected workbook into the private photo index.
  if (!tab || tab.sheetType !== "GRID" || tab.gridProperties.columnCount < photoHeaders.length) return [];
  const existing = await sheets.values.get({ spreadsheetId, range: "'Driver Photos'!A1:C1" }, options);
  const actual = existing.data.values?.[0] ?? [];
  if (photoHeaders.some((name, index) => name !== actual[index])) return [];

  const { rows } = await db.query(
    `SELECT d.id, d.name, d.driver_number::text AS driver_number
     FROM public.drivers d
     WHERE d.company_id = 1 AND EXISTS (
       SELECT 1 FROM storage.objects
       WHERE bucket_id = $1 AND name = $2 || d.id::text || '.jpg'
     )
     ORDER BY d.driver_number, d.id`,
    [bucketName, photoPrefix]
  );
  const { sheetId, gridProperties: { rowCount } } = tab;
  const requiredRows = Math.max(rowCount, rows.length + 1, 2);
  const requests = [];
  if (requiredRows > rowCount) {
    requests.push({ appendDimension: { sheetId, dimension: "ROWS", length: requiredRows - rowCount } });
  }
  requests.push({ updateCells: {
    range: { sheetId, startRowIndex: 1, endRowIndex: requiredRows, startColumnIndex: 0, endColumnIndex: photoHeaders.length },
    fields: "userEnteredValue,textFormatRuns",
    rows: rows.map((driver) => ({ values: [
      { userEnteredValue: { stringValue: formatDriverCompanyId(driver.driver_number) ?? driver.id } },
      { userEnteredValue: { stringValue: driver.name ?? "" } },
      {
        userEnteredValue: { stringValue: "View selfie (Admin)" },
        textFormatRuns: [{
          startIndex: 0,
          format: { link: { uri: adminPhotoUrl + "?photo=" + encodeURIComponent(driver.id) } },
        }],
      },
    ] })),
  } });
  return requests;
}

async function writeReport(db, spreadsheetId) {
  const account = credentials();
  if (!account) fail(503, "Google Sheets credentials are missing from the backend.");
  const { google } = require("googleapis");
  const auth = new google.auth.JWT({
    ...account,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth }).spreadsheets;
  const { rows } = await db.query(
    `SELECT number::text, source, kind, status, created_at, requested_date::text,
       stop_count, quote_cents, accepted_at, updated_at
     FROM dispatch_private.business_requests AS requests
     WHERE company_id = 1 ORDER BY requests.number LIMIT $1`,
    [maxRows]
  );
  if (rows.length >= maxRows) fail(409, "The Business Requests report has reached its 10,000-row limit.");

  const report = [headers, ...rows.map((row) => [
    "BR-" + row.number.padStart(4, "0"),
    row.source === "manual" ? "Manual" : "Website",
    row.kind === "bulk" ? "Bulk courier" : "Contract service",
    row.status,
    row.created_at.toISOString(),
    row.requested_date,
    row.stop_count,
    row.quote_cents === null ? null : row.quote_cents / 100,
    row.accepted_at?.toISOString(),
    row.updated_at.toISOString(),
  ])];

  try {
    const result = await sheets.get({
      spreadsheetId, fields: "sheets(properties(sheetId,title,sheetType,gridProperties(rowCount,columnCount)))",
    }, options);
    const tabs = (result.data.sheets ?? []).map((tab) => tab.properties);
    const tab = tabs.find((item) => item.title === title);
    const sheetId = tab ? tab.sheetId : Math.max(0, ...tabs.map((item) => item.sheetId)) + 1;
    const rowCount = Math.max(tab?.gridProperties?.rowCount ?? 1000, report.length);
    const requests = [];

    if (tab) {
      if (tab.sheetType !== "GRID") fail(409, "Choose a spreadsheet with a standard Business Requests tab.");
      const existing = await sheets.values.get({ spreadsheetId, range: "'Business Requests'!A1:J1" }, options);
      const actual = existing.data.values?.[0] ?? [];
      if (actual.length !== headers.length || headers.some((name, index) => name !== actual[index])) {
        fail(409, "That spreadsheet already has a different Business Requests tab. Choose another spreadsheet or rename that tab.");
      }
      if (rowCount > tab.gridProperties.rowCount) {
        requests.push({ appendDimension: { sheetId, dimension: "ROWS", length: rowCount - tab.gridProperties.rowCount } });
      }
    } else {
      requests.push({ addSheet: { properties: { sheetId, title, gridProperties: {
        rowCount, columnCount: headers.length, frozenRowCount: 1,
      } } } });
    }

    requests.push({ updateCells: {
      range: { sheetId, startRowIndex: 0, endRowIndex: rowCount, startColumnIndex: 0, endColumnIndex: headers.length },
      fields: "userEnteredValue",
      rows: report.map((row) => ({ values: row.map((value) => ({
        userEnteredValue: typeof value === "number" ? { numberValue: value } : { stringValue: value ?? "" },
      })) })),
    } });
    requests.push(...await driverPhotoRequests(db, sheets, spreadsheetId, tabs.find((item) => item.title === "Driver Photos")));
    await sheets.batchUpdate({ spreadsheetId, requestBody: { requests } }, options);
  } catch (error) {
    if (error.statusCode) throw error;
    const code = error.response?.status;
    if ([401, 403, 404].includes(code) || error.response?.data?.error === "invalid_grant") {
      fail(424, "Google could not open the spreadsheet for editing. Check the link and share it with the service account as Editor.");
    }
    fail(424, "Google Sheets could not be updated. Try Sync now again shortly.");
  }
}

async function syncBusinessRequestSheet(pool, body = null) {
  const connecting = body?.action === "connect";
  if (body && (!["connect", "sync"].includes(body.action) ||
      (connecting && (typeof body.spreadsheet_id !== "string" || !/^[A-Za-z0-9_-]{20,120}$/.test(body.spreadsheet_id))))) {
    fail(400, "Enter a valid Google Sheets link.");
  }

  const db = await pool.connect();
  let releaseError;
  try {
    await db.query("BEGIN");
    const lock = await db.query("SELECT pg_try_advisory_xact_lock(574143, 1) AS locked");
    if (!lock.rows[0].locked) {
      if (body) fail(409, "A Google Sheets sync is already running. Try again shortly.");
      return;
    }
    const config = await readConfig(db);
    const spreadsheetId = connecting ? body.spreadsheet_id : config.spreadsheet_id;
    if (!spreadsheetId) {
      if (body) fail(409, "Connect a Google Sheet first.");
      return;
    }
    if (!body && config.revision === config.synced_revision) return;

    await writeReport(db, spreadsheetId);
    const { rows } = await db.query(
      `UPDATE ${table} SET spreadsheet_id = $1, synced_revision = $2, synced_at = now()
       WHERE company_id = 1 RETURNING spreadsheet_id, revision, synced_revision, synced_at`,
      [spreadsheetId, config.revision]
    );
    await db.query("COMMIT");
    return status(rows[0]);
  } finally {
    try {
      await db.query("ROLLBACK");
    } catch (error) {
      releaseError = error;
    }
    db.release(releaseError);
  }
}

function startBusinessRequestSheetSync(pool) {
  if (!credentials()) return;
  const tick = async () => {
    try {
      await syncBusinessRequestSheet(pool);
    } catch (error) {
      console.error("[BUSINESS REQUEST SHEET]", error.code || error.statusCode || error.name);
    } finally {
      setTimeout(tick, 60000).unref();
    }
  };
  setTimeout(tick, 60000).unref();
}

module.exports = { readSheetStatus, syncBusinessRequestSheet, startBusinessRequestSheetSync };
