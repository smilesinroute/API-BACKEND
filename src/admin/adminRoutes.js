"use strict";

const { requireAdmin } = require("./adminAuth");

/**
 * ADMIN ROUTES
 * ============
 * Dispatch control surface
 */

async function handleAdminRoutes(req, res, pool, pathname, method, json) {
  /* ---------- LIST ORDERS ---------- */
  if (pathname === "/admin/orders" && method === "GET") {
    requireAdmin(req);

    const { rows } = await pool.query(`
      SELECT *
      FROM orders
      ORDER BY created_at DESC
    `);

    json(res, 200, { orders: rows });
    return true;
  }

  /* ---------- APPROVE ORDER ---------- */
  if (
    pathname.startsWith("/admin/orders/") &&
    pathname.endsWith("/approve") &&
    method === "POST"
  ) {
    requireAdmin(req);

    const id = pathname.split("/")[3];

    const { rows } = await pool.query(
      `
      UPDATE orders
      SET status = 'approved_pending_payment'
      WHERE id = $1
      RETURNING *
      `,
      [id]
    );

    json(res, 200, { order: rows[0] });
    return true;
  }

  /* ---------- REJECT ORDER ---------- */
  if (
    pathname.startsWith("/admin/orders/") &&
    pathname.endsWith("/reject") &&
    method === "POST"
  ) {
    requireAdmin(req);

    const id = pathname.split("/")[3];

    await pool.query(
      `
      UPDATE orders
      SET status = 'rejected'
      WHERE id = $1
      `,
      [id]
    );

    json(res, 200, { success: true });
    return true;
  }

  return false;
}

module.exports = { handleAdminRoutes };
