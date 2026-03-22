const pool = require("../db");

module.exports = async function (req, res, pathname) {

const method = req.method;

// ✅ NO /api
if (!pathname.startsWith("/saas/company")) return false;

if (method !== "GET") return false;

try {


/* =========================
   GET DOMAIN / HOST
========================= */

const host = req.headers.host;

if (!host) {
  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Missing host" }));
  return true;
}

/* =========================
   TEMP LOCAL FALLBACK
========================= */

if (host.includes("localhost")) {

  const company = {
    id: 1,
    name: "Local Company"
  };

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(company));
  return true;
}

/* =========================
   REAL DATABASE LOOKUP
========================= */

const result = await pool.query(
  "SELECT id, company_name FROM companies WHERE domain = $1 LIMIT 1",
  [host]
);

if (result.rows.length === 0) {
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Company not found" }));
  return true;
}

const company = {
  id: result.rows[0].id,
  name: result.rows[0].company_name
};

res.writeHead(200, { "Content-Type": "application/json" });
res.end(JSON.stringify(company));

return true;


} catch (err) {


console.error("Company lookup error:", err);

res.writeHead(500, { "Content-Type": "application/json" });
res.end(JSON.stringify({ error: "Server error" }));

return true;


}

};
