// apps/api/scheduling-server.js
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const router = express.Router();

/* =========================
   Middleware
========================= */
router.use(cors());
router.use(express.json());

/* =========================
   Supabase Client
========================= */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* =========================
   Health Check
========================= */
router.get("/", (_req, res) => {
  res.json({
    status: "Scheduling API is running",
    timestamp: new Date().toISOString(),
  });
});

/* ======================================================
   GET available slots
   /scheduling/api/available-slots/:date?serviceType=
====================================================== */
router.get("/api/available-slots/:date", async (req, res) => {
  const { date } = req.params;
  const { serviceType = "delivery" } = req.query;

  try {
    let bookedTimes = [];

    /* ---------- DELIVERY ---------- */
    if (serviceType === "delivery") {
      const { data, error } = await supabase
        .from("deliveries")
        .select("delivery_time")
        .eq("delivery_date", date)
        .neq("status", "cancelled");

      if (error) throw error;

      bookedTimes = (data || []).map((d) => d.delivery_time);
    }

    /* ---------- NOTARY ---------- */
    if (serviceType === "notary") {
      const { data, error } = await supabase
        .from("notary_appointments")
        .select("appointment_time")
        .eq("appointment_date", date)
        .neq("status", "cancelled");

      if (error) throw error;

      bookedTimes = (data || []).map((n) => n.appointment_time);
    }

    const availableSlots = generateTimeSlots(serviceType).filter(
      (slot) => !bookedTimes.includes(slot)
    );

    res.json({
      date,
      serviceType,
      availableSlots,
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

/* ======================================================
   POST create appointment (SCHEDULING HOLD)
   /scheduling/api/appointments
====================================================== */
router.post("/api/appointments", async (req, res) => {
  const { serviceType, date, time } = req.body;

  if (!serviceType || !date || !time) {
    return res.status(400).json({
      error: "serviceType, date, and time are required",
    });
  }

  try {
    /* ---------- DELIVERY ---------- */
    if (serviceType === "delivery") {
      const { error } = await supabase.from("deliveries").insert({
        delivery_date: date,
        delivery_time: time,
        status: "scheduled",

        // REQUIRED NON-NULL FIELDS (SAFE PLACEHOLDERS)
        customer_name: "Scheduling Hold",
        customer_email: "pending@smilesinroute.delivery",
        customer_phone: "0000000000",
        pickup_address: "TBD",
        delivery_address: "TBD",

        distance_miles: 0,
        base_rate: 0,
        per_mile_rate: 0,
        total_cost: 0,

        fragile: false,
        priority: false,
        time_sensitive: false,
        weekend: false,
        holiday: false,
        after_hours: false,
      });

      if (error) throw error;
    }

    /* ---------- NOTARY ---------- */
    if (serviceType === "notary") {
      const { error } = await supabase.from("notary_appointments").insert({
        appointment_date: date,
        appointment_time: time,
        status: "scheduled",

        customer_name: "Scheduling Hold",
        customer_email: "pending@smilesinroute.delivery",
        customer_phone: "0000000000",
        appointment_address: "TBD",
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
    res.status(500).json({
      error: "Failed to create appointment",
      details: err.message,
    });
  }
});

/* ======================================================
   Slot Generator
====================================================== */
function generateTimeSlots(serviceType) {
  const slots = [];

  const startHour = serviceType === "notary" ? 9 : 8;
  const endHour = serviceType === "notary" ? 17 : 18;
  const intervalMinutes = serviceType === "notary" ? 60 : 30;

  for (let h = startHour; h < endHour; h++) {
    for (let m = 0; m < 60; m += intervalMinutes) {
      slots.push(
        `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
      );
    }
  }

  return slots;
}

module.exports = router;
