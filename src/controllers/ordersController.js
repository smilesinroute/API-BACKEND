"use strict";

/**
 * Orders Controller (Production)
 * ------------------------------
 * Exposes /api/orders via the Node router
 * Admin-only lifecycle control
 */

async function handleOrders(req, res, pool, pathname, method, json) {
  if (!pathname.startsWith("/api/orders")) return false;

  const parts = pathname.split("/").filter(Boolean);
  const id = parts[2] || null;

  /* ============================
     GET /api/orders
  ============================ */
  if (method === "GET" && parts.length === 2) {
    const { rows } = await pool.query(`
      SELECT *
      FROM orders
      ORDER BY created_at DESC
    `);
    return json(res, 200, rows);
  }

  /* ============================
     GET /api/orders/:id
  ============================ */
  if (method === "GET" && id) {
    const { rows } = await pool.query(
      `SELECT * FROM orders WHERE id = $1 LIMIT 1`,
      [id]
    );

    if (!rows.length) {
      return json(res, 404, { error: "Order not found" });
    }

    return json(res, 200, rows[0]);
  }

  /* ============================
     POST /api/orders
  ============================ */
  if (method === "POST" && parts.length === 2) {
    const body = await readJson(req);

    if (!body.customer_email) {
      return json(res, 400, { error: "customer_email is required" });
    }

    const { rows } = await pool.query(
      `
      INSERT INTO orders (
        customer_id,
        customer_email,
        pickup_address,
        delivery_address,
        scheduled_date,
        scheduled_time,
        distance_miles,
        total_amount,
        status
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'confirmed_pending_payment')
      RETURNING *
      `,
      [
        body.customer_id || null,
        body.customer_email,
        body.pickup_address,
        body.delivery_address,
        body.scheduled_date,
        body.scheduled_time,
        body.distance_miles || 0,
        body.total_amount || 0,
      ]
    );

    return json(res, 201, rows[0]);
  }

  return false;
}

/* ===== minimal JSON body reader ===== */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(JSON.parse(data || "{}")));
    req.on("error", reject);
  });
}

module.exports = { handleOrders };
