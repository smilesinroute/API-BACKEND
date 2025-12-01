// src/utils/googleSheets.js
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

// Load your service account key
const KEYFILE = path.join(__dirname, '../../google-service-account.json'); 
// Make sure this file exists in /apps/api/google-service-account.json

// Authenticate
function getAuth() {
  if (!fs.existsSync(KEYFILE)) {
    throw new Error(
      `Google service account key not found at: ${KEYFILE}. ` +
      `Make sure your JSON key file is placed correctly.`
    );
  }

  return new google.auth.GoogleAuth({
    keyFile: KEYFILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

// Append a row to a sheet
async function appendRow(spreadsheetId, range, values) {
  try {
    const auth = await getAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    const response = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [values],
      },
    });

    return response.data;
  } catch (err) {
    console.error('Google Sheets Append Error:', err);
    throw err;
  }
}

// Update entire sheet range (optional future use)
async function updateRange(spreadsheetId, range, values) {
  try {
    const auth = await getAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    const response = await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values,
      },
    });

    return response.data;
  } catch (err) {
    console.error('Google Sheets Update Error:', err);
    throw err;
  }
}

module.exports = {
  appendRow,
  updateRange,
};

