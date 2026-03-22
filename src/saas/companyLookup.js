const pool = require("../db");

module.exports = async function (req, res, pathname) {

const method = req.method;

// =========================
// ROUTE CHECK
// =========================
if (!pathname.startsWith("/saas/company")) return false;
if (method !== "GET") return false;

try {


// =========================
// GET HOST
// =========================
const host = req.headers.host;

if (!host) {
  return sendJSON(res, 400, { error: "Missing host" });
}

// =========================
// LOCAL DEVELOPMENT FALLBACK
// =========================
if (host.includes("localhost")) {
  return sendJSON(res, 200, {
    id: 1,
    name: "Local Company"
  });
}

// =========================
// DATABASE LOOKUP
// =========================
const result = await pool.query(
  `SELECT id, company_name 
   FROM companies 
   WHERE domain = $1 
   LIMIT 1`,
  [host]
);

if (result.rows.length === 0) {
  return sendJSON(res, 404, { error: "Company not found" });
}

const company = {
  id: result.rows[0].id,
  name: result.rows[0].company_name
};

return sendJSON(res, 200, company);


} catch (err) {


console.error("Company lookup error:", err);
return sendJSON(res, 500, { error: "Server error" });


}

};

// =========================
// HELPER
// =========================
function sendJSON(res, status, data) {
res.writeHead(status, { "Content-Type": "application/json" });
res.end(JSON.stringify(data));
}
