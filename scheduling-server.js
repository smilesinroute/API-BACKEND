// apps/api/scheduling-server.js
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const router = express.Router();

router.use(cors());
router.use(express.json());

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Health check
 */
router.get("/", (_req, res) => {
  res.json({
    status: "Scheduling API is running",
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET available time slots
 * /scheduling/api/available-slots/:date?serviceType=delivery|notary
 */
router.get("/api/available-slots/:date", async (req, res) => {
  const { date } = req.params;
  const { serviceType = "delivery" } = req.query;

  try {
    let bookedTimes = [];

    if (serviceType === "delivery") {
      const { data, error } = await supabase
        .from("deliveries")
        .select("scheduled_time")
        .eq("delivery_date", date)
        .neq("status", "cancelled");

      if (error) return res.status(500).json({ error: error.message });
      bookedTimes = (data || []).map((d) => d.scheduled_time);
    }

    if (serviceType === "notary") {
      const { data, error } = await supabase
        .from("notary_appointments")
        .select("scheduled_time")
        .eq("appointment_date", date)
        .neq("status", "cancelled");

      if (error) return res.status(500).json({ error: error.message });
      bookedTimes = (data || []).map((n) => n.scheduled_time);
    }

    const slots = generateTimeSlots(serviceType).filter(
      (slot) => !bookedTimes.includes(slot)
    );

    res.json({
      date,
      serviceType,
      availableSlots: slots,
      bookedSlots: bookedTimes,
    });
  } catch (err) {
    console.error("❌ available-slots error:", err);
    res.status(500).json({
      error: "Failed to fetch available slots",
      details: err.message,
    });
  }
});

/**
 * SLOT GENERATOR (matches business reality)
 */
function generateTimeSlots(serviceType) {
  const slots = [];
  const startHour = serviceType === "notary" ? 9 : 8;
  const endHour = serviceType === "notary" ? 17 : 18;
  const interval = serviceType === "notary" ? 60 : 30;

  for (let h = startHour; h < endHour; h++) {
    for (let m = 0; m < 60; m += interval) {
      const time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      slots.push(time);
    }
  }

  return slots;
}

module.exports = router;

