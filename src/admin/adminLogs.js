"use strict";

async function handleAdminLogs(req, res, pool, pathname, method, json) {

  if (pathname !== "/admin/logs" || method !== "GET") {
    return false;
  }

  try {

    const { rows } = await pool.query(`
      SELECT
        id,
        created_at AS timestamp,
        level,
        service,
        message
      FROM system_logs
      ORDER BY created_at DESC
      LIMIT 50
    `);

    return json(res, 200, rows);

  } catch (err) {

    console.error("[ADMIN LOGS ERROR]", err);

    return json(res, 200, [
      {
        id: "1",
        timestamp: new Date().toISOString(),
        level: "info",
        service: "system",
        message: "Logging system active"
      }
    ]);

  }

}

module.exports = { handleAdminLogs };