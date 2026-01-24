"use strict";

require("dotenv").config();
const { appendOrderRow } = require("./src/integrations/googleSheets");

(async () => {
  await appendOrderRow({
    order_id: "TEST-ORDER-001",
    service_type: "courier",
    date: "2026-01-15",
    time: "10:30",
    customer_email: "test@example.com",
    amount: 46.25,
    status: "TEST",
    stripe_session: "cs_test_xxx",
    driver: "Unassigned",
    created_at: new Date().toISOString(),
  });

  console.log("✅ Row appended successfully");
})();
