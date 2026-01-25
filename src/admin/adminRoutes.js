"use strict";

const { requireAdmin } = require("./adminAuth");

/**
 * ADMIN ROUTES
 * ============
 * Dispatch control surface
 */

async function handleAdminRoutes(req, res, pool, pathname, method, json) {

  /* ======================================================
     DASHBOARD SUMMARY
     GET /admin/dashboard
  ====================================================== */
  if (pathname === "/admin/dashboard" && method === "GET") {
    requireAdmin(req);

    const [
      pendingRes,
      transitRes,
      driversRes,
      revenueRes,
    ] = await Promise.all([
      pool.query(`
        SELECT COUNT(*)::int AS count
        FROM orders
        WHERE status = 'confirmed_pending_payment'
      `),
      pool.query(`
        SELECT COUNT(*)::int AS count
        FROM orders
        WHERE status = 'in_progress'
      `),
      pool.query(`
        SELECT COUNT(*)::int AS count
        FROM drivers
        WHERE active = true
      `),
      pool.query(`
        SELECT COALESCE(SUM(total_amount), 0)::numeric AS total
        FROM orders
        WHERE created_at::date = CURRENT_DATE
      `),
    ]);

    json(res, 200, {
      pendingOrders: pendingRes.rows[0].count,
      inTransit: transitRes.rows[0].count,
      activeDrivers: driversRes.rows[0].count,
      revenueToday: Number(revenueRes.rows[0].total),
    });

    return true;
  }

  /* ======================================================
     LIST ORDERS
     GET /admin/orders
  ====================================================== */
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

  /* ======================================================
     APPROVE ORDER
     POST /admin/orders/:id/approve
  ====================================================== */
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

  /* ======================================================
     REJECT ORDER
     POST /admin/orders/:id/reject
  ====================================================== */
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
