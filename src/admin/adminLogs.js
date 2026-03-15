"use strict";

async function handleAdminLogs(req, res, pool, pathname, method, json) {

  if (pathname !== "/api/admin/logs" || method !== "GET") {
    return false;
  }

  try {

    const logs = await pool.query(`
      SELECT id, level, message, created_at
      FROM system_logs
      ORDER BY created_at DESC
      LIMIT 50
    `);

    return json(res, 200, logs.rows);

  } catch (err) {

    console.error("[ADMIN LOGS ERROR]", err);

    return json(res, 500, {
      error: "Failed to fetch logs"
    });

  }

}

module.exports = { handleAdminLogs };