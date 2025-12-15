const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

/**
 * Supabase client
 */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const router = express.Router();
router.use(cors());
router.use(express.json());

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
 * Courier → deliveries
 * Notary → notary_appointments
 */
router.get("/api/available-slots/:date", async (req, res) => {
  try {
    const { date } = req.params;
    const { serviceType = "delivery" } = req.query;

    const requestedDate = new Date(date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (requestedDate < today) {
      return res.status(400).json({ error: "Past dates are not allowed" });
    }

    let table;
    let timeColumn;

    if (serviceType === "notary") {
      table = "notary_appointments";
      timeColumn = "scheduled_time";
    } else {
      table = "deliveries";
      timeColumn = "scheduled_time";
    }

    const { data: existing, error } = await supabase
      .from(table)
      .select(timeColumn)
      .eq("scheduled_date", date)
      .eq("status", "scheduled");

    if (error) throw error;

    const bookedTimes = (existing || []).map((r) => r[timeColumn]);
    const availableSlots = generateTimeSlots(date, serviceType, bookedTimes);

    res.json({
      date,
      serviceType,
      availableSlots,
      bookedCount: bookedTimes.length,
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
 * POST schedule courier delivery
 * Updates existing delivery row
 */
router.post("/api/schedule-delivery", async (req, res) => {
  try {
    const { orderId, scheduledDate, scheduledTime } = req.body;

    if (!orderId || !scheduledDate || !scheduledTime) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const { error } = await supabase
      .from("deliveries")
      .update({
        scheduled_date: scheduledDate,
        scheduled_time: scheduledTime,
        status: "scheduled",
      })
      .eq("order_id", orderId);

    if (error) throw error;

    res.json({
      success: true,
      scheduledDate,
      scheduledTime,
    });
  } catch (err) {
    console.error("❌ schedule-delivery error:", err);
    res.status(500).json({
      error: "Failed to schedule delivery",
      details: err.message,
    });
  }
});

/**
 * POST schedule notary appointment
 */
router.post("/api/schedule-notary", async (req, res) => {
  try {
    const {
      customer_id,
      scheduled_date,
      scheduled_time,
      location,
      notes,
    } = req.body;

    if (!customer_id || !scheduled_date || !scheduled_time) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const { data, error } = await supabase
      .from("notary_appointments")
      .insert({
        customer_id,
        scheduled_date,
        scheduled_time,
        location,
        notes,
        status: "scheduled",
      })
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, appointment: data });
  } catch (err) {
    console.error("❌ schedule-notary error:", err);
    res.status(500).json({
      error: "Failed to schedule notary appointment",
      details: err.message,
    });
  }
});

/**
 * Time slot generator
 */
function generateTimeSlots(date, serviceType, bookedTimes = []) {
  const day = new Date(date).getDay();
  const isWeekend = day === 0 || day === 6;

  const hours =
    serviceType === "notary"
      ? { start: 9, end: 17 }
      : isWeekend
      ? { start: 9, end: 16 }
      : { start: 8, end: 18 };

  const interval = serviceType === "notary" ? 60 : 30;
  const slots = [];

  for (let h = hours.start; h < hours.end; h++) {
    for (let m = 0; m < 60; m += interval) {
      const time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      if (!bookedTimes.includes(time)) {
        slots.push(time);
      }
    }
  }

  return slots;
}

module.exports = router;
