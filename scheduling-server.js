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
   Scheduling Business Rules
========================= */
const BUSINESS_RULES = {
  delivery: {
    weekday: { start: 8, end: 18 },
    weekend: { start: 9, end: 17 },
    slotMinutes: 30,
    allowWeekends: true,
    allowAfterHours: true,
  },
  notary: {
    weekday: { start: 9, end: 17 },
    weekend: null,
    slotMinutes: 60,
    allowWeekends: false,
    allowAfterHours: false,
  },
};

/* =========================
   Helpers
========================= */
function isWeekend(dateStr) {
  const day = new Date(dateStr + "T00:00:00").getDay();
  return day === 0 || day === 6;
}

function isAfterHours(time, rules, weekend) {
  const hour = Number(time.split(":")[0]);
  const hours = weekend ? rules.weekend : rules.weekday;
  if (!hours) return true;
  return hour < hours.start || hour >= hours.end;
}

function generateTimeSlots(serviceType, date) {
  const rules = BUSINESS_RULES[serviceType];
  if (!rules) return [];

  const weekend = isWeekend(date);
  if (weekend && !rules.allowWeekends) return [];

  const hours = weekend ? rules.weekend : rules.weekday;
  if (!hours) return [];

  const slots = [];

  for (let h = hours.start; h < hours.end; h++) {
    for (let m = 0; m < 60; m += rules.slotMinutes) {
      slots.push(
        `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
      );
    }
  }

  return slots;
}

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

    const rules = BUSINESS_RULES[serviceType];
    const weekend = isWeekend(date);

    const availableSlots = generateTimeSlots(serviceType, date)
      .filter((slot) => !bookedTimes.includes(slot))
      .map((slot) => ({
        time: slot,
        weekend,
        after_hours: isAfterHours(slot, rules, weekend),
      }));

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
    const rules = BUSINESS_RULES[serviceType];
    if (!rules) throw new Error("Invalid serviceType");

    const weekend = isWeekend(date);
    const afterHours = isAfterHours(time, rules, weekend);

    /* ---------- DELIVERY ---------- */
    if (serviceType === "delivery") {
      const { error } = await supabase.from("deliveries").insert({
        delivery_date: date,
        delivery_time: time,
        status: "scheduled",

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
        weekend,
        holiday: false,
        after_hours: afterHours,
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
      weekend,
      after_hours: afterHours,
    });
  } catch (err) {
    console.error("❌ create appointment error:", err);
    res.status(500).json({
      error: "Failed to create appointment",
      details: err.message,
    });
  }
});

module.exports = router;
