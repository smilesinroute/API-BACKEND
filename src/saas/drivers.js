const pool = require("../db");

module.exports = async function (req, res, pathname) {

const method = req.method;

// =========================
// ROUTE CHECK
// =========================
if (!pathname.startsWith("/saas/drivers")) return false;

try {


// =========================
// COMPANY CONTEXT
// =========================
const companyId = req.headers["x-company-id"];

if (!companyId) {
  return sendJSON(res, 400, { error: "Missing company_id" });
}

// =========================
// GET DRIVERS
// =========================
if (method === "GET") {

  const result = await pool.query(
    `SELECT id, name, email 
     FROM drivers 
     WHERE company_id = $1 
     ORDER BY created_at DESC`,
    [companyId]
  );

  return sendJSON(res, 200, result.rows);
}

// =========================
// CREATE DRIVER
// =========================
if (method === "POST") {

  let body = "";

  req.on("data", chunk => {
    body += chunk;
  });

  req.on("end", async () => {

    try {

      const data = JSON.parse(body || "{}");

      if (!data.name || !data.email) {
        return sendJSON(res, 400, { error: "Missing fields" });
      }

      const result = await pool.query(
        `INSERT INTO drivers (name, email, company_id)
         VALUES ($1, $2, $3)
         RETURNING id, name, email`,
        [data.name, data.email, companyId]
      );

      return sendJSON(res, 201, result.rows[0]);

    } catch (err) {

      console.error("Driver POST error:", err);
      return sendJSON(res, 500, { error: "Insert failed" });

    }

  });

  return true;
}

// =========================
// NOT HANDLED
// =========================
return false;


} catch (err) {


console.error("Drivers error:", err);
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
