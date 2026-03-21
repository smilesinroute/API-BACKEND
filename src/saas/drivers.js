module.exports = async function (req, res, pathname) {

  const method = req.method;

  // ✅ IMPORTANT: NO /api HERE
  if (!pathname.startsWith("/saas/drivers")) return false;

  try {

    /* =========================
       GET DRIVERS
    ========================= */
    if (method === "GET") {

      const drivers = [
        {
          id: 1,
          name: "Test Driver",
          email: "test@driver.com",
          company_id: 1
        }
      ];

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(drivers));

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

      req.on("end", () => {

        const data = JSON.parse(body || "{}");

        const newDriver = {
          id: Date.now(),
          name: data.name,
          email: data.email,
          company_id: data.company_id
        };

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(newDriver));
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