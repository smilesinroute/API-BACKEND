const { google } = require('googleapis');
const path = require('path');

const KEYFILEPATH = path.join(__dirname, '../credentials/google-sheets.json'); // adjust if needed
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

const auth = new google.auth.GoogleAuth({
    keyFile: KEYFILEPATH,
    scopes: SCOPES,
});

const sheets = google.sheets({ version: 'v4', auth });

async function appendRow(spreadsheetId, range, values) {
    try {
        const res = await sheets.spreadsheets.values.append({
            spreadsheetId,
            range,
            valueInputOption: 'RAW',
            resource: { values: [values] },
        });
        return res.data;
    } catch (err) {
        console.error('Error writing to Google Sheet:', err);
        throw err;
    }
}

module.exports = { appendRow };
