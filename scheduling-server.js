const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const router = express.Router();

router.use(cors());
router.use(express.json());

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
 * GET available slots
 */
router.get("/api/available-slots/:date", async (req, res) => {
  const { date } = req.params;
  const { serviceType = "delivery" } = req.query;

  try {
    let bookedTimes = [];

    if (serviceType === "delivery") {
      const { data, error } = await supabase
        .from("deliveries")
        .select("delivery_time")
        .eq("delivery_date", date)
        .neq("status", "cancelled");

      if (error) throw error;
      bookedTimes = data.map(d => d.delivery_time);
    }

    if (serviceType === "notary") {
      const { data, error } = await supabase
        .from("notary_appointments")
        .select("appointment_time")
        .eq("appointment_date", date)
        .neq("status", "cancelled");

      if (error) throw error;
      bookedTimes = data.map(n => n.appointment_time);
    }

    const slots = generateTimeSlots(serviceType).filter(
      slot => !bookedTimes.includes(slot)
    );

    res.json({
      date,
      serviceType,
      availableSlots: slots,
      bookedSlots: bookedTimes,
    });
  } catch (err) {
    console.error("❌ available-slots error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST create appointment  ✅ THIS IS NEW
 */
router.post("/api/appointments", async (req, res) => {
  const { serviceType, date, time } = req.body;

  if (!serviceType || !date || !time) {
    return res.status(400).json({
      error: "serviceType, date, and time are required",
    });
  }

  try {
    if (serviceType === "delivery") {
      const { error } = await supabase
        .from("deliveries")
        .insert({
          delivery_date: date,
          delivery_time: time,
          status: "scheduled",
        });

      if (error) throw error;
    }

    if (serviceType === "notary") {
      const { error } = await supabase
        .from("notary_appointments")
        .insert({
          appointment_date: date,
          appointment_time: time,
          status: "scheduled",
        });

      if (error) throw error;
    }

    res.json({
      success: true,
      serviceType,
      date,
      time,
    });
  } catch (err) {
    console.error("❌ create appointment error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Slot generator
 */
function generateTimeSlots(serviceType) {
  const slots = [];
  const start = serviceType === "notary" ? 9 : 8;
  const end = serviceType === "notary" ? 17 : 18;
  const step = serviceType === "notary" ? 60 : 30;

  for (let h = start; h < end; h++) {
    for (let m = 0; m < 60; m += step) {
      slots.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
  }
  return slots;
}

module.exports = router;
