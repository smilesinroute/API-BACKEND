"use strict";

async function handleAdminStats(req, res, pool, pathname, method, json) {

  if (pathname !== "/admin/stats" || method !== "GET") {
    return false;
  }

  try {

    const drivers = await pool.query(
      "SELECT COUNT(*) FROM drivers WHERE status='online'"
    );

    const orders = await pool.query(
      "SELECT COUNT(*) FROM orders WHERE status='active'"
    );

    const users = await pool.query(
      "SELECT COUNT(*) FROM users"
    );

    const stats = {
      drivers_online: Number(drivers.rows[0].count || 0),
      active_orders: Number(orders.rows[0].count || 0),
      total_users: Number(users.rows[0].count || 0),
      uptime: process.uptime()
    };

    return json(res, 200, stats);

  } catch (err) {

    console.error("[ADMIN STATS ERROR]", err);

    return json(res, 500, {
      error: "Failed to fetch stats"
    });

  }

}

module.exports = { handleAdminStats };