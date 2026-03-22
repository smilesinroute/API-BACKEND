const pool = require("../db");

module.exports = async function saasOrders(req, res, pathname) {

const method = req.method;

// =========================
// ROUTE CHECK
// =========================
if (!pathname.startsWith("/saas/orders")) return false;

const parts = pathname.split("/").filter(Boolean);

try {


// =========================
// COMPANY CONTEXT
// =========================
const companyId = req.headers["x-company-id"];

if (!companyId) {
  return sendJSON(res, 400, { error: "Missing company_id" });
}

// =========================
// GET ALL ORDERS
// =========================
if (method === "GET" && parts.length === 2) {

  const result = await pool.query(
    `SELECT id, pickup_address, delivery_address, status, distance_miles
     FROM orders
     WHERE company_id = $1
     ORDER BY created_at DESC`,
    [companyId]
  );

  return sendJSON(res, 200, result.rows);
}

// =========================
// CREATE ORDER
// =========================
if (method === "POST" && parts.length === 2) {

  let body = "";

  req.on("data", chunk => {
    body += chunk;
  });

  req.on("end", async () => {

    try {

      const data = JSON.parse(body || "{}");

      if (!data.pickup_address || !data.delivery_address) {
        return sendJSON(res, 400, { error: "Missing fields" });
      }

      const result = await pool.query(
        `INSERT INTO orders (
          pickup_address,
          delivery_address,
          customer_name,
          customer_phone,
          company_id,
          status
        )
        VALUES ($1, $2, $3, $4, $5, 'pending')
        RETURNING id, pickup_address, delivery_address, status`,
        [
          data.pickup_address,
          data.delivery_address,
          data.customer_name || null,
          data.customer_phone || null,
          companyId
        ]
      );

      return sendJSON(res, 201, result.rows[0]);

    } catch (err) {

      console.error("Order POST error:", err);
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


console.error("SaaS Orders Error:", err);
return sendJSON(res, 500, { error: "Internal server error" });


}

};

// =========================
// HELPER
// =========================
function sendJSON(res, status, data) {
res.writeHead(status, { "Content-Type": "application/json" });
res.end(JSON.stringify(data));
}
