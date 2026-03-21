// src/saas/drivers.js

module.exports = async function saasDrivers(req, res, pathname) {

  const method = req.method;

  if (!pathname.startsWith("/saas/drivers")) return false;

  try {

    // ✅ GET /saas/drivers
    if (method === "GET") {

      // 🔥 TEMP: mock data (replace with DB next)
      const drivers = [
        {
          id: 1,
          name: "John Driver",
          email: "john@example.com",
          company_id: 1
        }
      ];

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(drivers));

      return true;
    }

    return false;

  } catch (err) {

    console.error("SaaS Drivers Error:", err);

    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Server error" }));

    return true;
  }
};