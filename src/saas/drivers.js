const pool = require("../db");

module.exports = async function (req, res, pathname) {

const method = req.method;

// ✅ NO /api
if (!pathname.startsWith("/saas/drivers")) return false;

try {


/* =========================
   COMPANY CONTEXT
========================= */

const companyId = req.headers["x-company-id"];

if (!companyId) {
  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Missing company_id" }));
  return true;
}

/* =========================
   GET DRIVERS
========================= */
if (method === "GET") {

  const result = await pool.query(
    `SELECT id, name, email 
     FROM drivers 
     WHERE company_id = $1 
     ORDER BY created_at DESC`,
    [companyId]
  );

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result.rows));

  return true;
}

/* =========================
   CREATE DRIVER
========================= */
if (method === "POST") {

  let body = "";

  req.on("data", chunk => {
    body += chunk;
  });

  req.on("end", async () => {

    try {

      const data = JSON.parse(body || "{}");

      if (!data.name || !data.email) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing fields" }));
        return;
      }

      const result = await pool.query(
        `INSERT INTO drivers (name, email, company_id)
         VALUES ($1, $2, $3)
         RETURNING id, name, email`,
        [data.name, data.email, companyId]
      );

      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result.rows[0]));

    } catch (err) {

      console.error("Driver POST error:", err);

      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Insert failed" }));
    }

  });

  return true;
}

return false;


} catch (err) {

console.error("Drivers error:", err);

res.writeHead(500, { "Content-Type": "application/json" });
res.end(JSON.stringify({ error: "Server error" }));

return true;


}

};
