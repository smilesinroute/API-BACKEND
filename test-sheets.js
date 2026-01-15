import { google } from "googleapis";

const auth = new google.auth.GoogleAuth({
  keyFile: "./google-service-account.json",
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

const spreadsheetId = "13VBOUB8TUGuvsROmOprzByiaoGi8QGs9sb8tAvklOIw";

async function run() {
  const res = await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: "A1:J1",
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        "Order ID",
        "Service",
        "Date",
        "Time",
        "Customer Email",
        "Amount",
        "Status",
        "Stripe Session",
        "Driver",
        "Created At"
      ]]
    }
  });

  console.log("✅ SUCCESS:", res.data);
}

run().catch(err => {
  console.error("❌ ERROR:", err.response?.data || err.message);
});
