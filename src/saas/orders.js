// src/saas/orders.js

module.exports = async function saasOrders(req, res, pathname) {
  const { method } = req;

  if (!pathname.startsWith("/saas/orders")) return false;

  const parts = pathname.split("/").filter(Boolean);
  // /saas/orders → ["saas", "orders"]

  try {
    // ✅ GET /saas/orders
    if (method === "GET" && parts.length === 2) {
      const orders = await getAllOrders(); // replace with your DB logic

      return sendJSON(res, 200, orders);
    }

    // ❌ Not handled
    return false;

  } catch (err) {
    console.error("SaaS Orders Error:", err);
    return sendJSON(res, 500, { error: "Internal server error" });
  }
};


// 🔧 helper (add if you don’t already have one)
function sendJSON(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}


// 🔧 TEMP mock (replace later)
async function getAllOrders() {
  return [
    { id: 1, customer: "Test Order", status: "pending" }
  ];
}