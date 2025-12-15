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
        .select("delivery_time")
        .eq("delivery_date", date)
        .neq("status", "cancelled");

      if (error) return res.status(500).json({ error: error.message });
      bookedTimes = (data || []).map((d) => d.delivery_time);
    }

    if (serviceType === "notary") {
      const { data, error } = await supabase
        .from("notary_appointments")
        .select("appointment_time")
        .eq("appointment_date", date)
        .neq("status", "cancelled");

      if (error) return res.status(500).json({ error: error.message });
      bookedTimes = (data || []).map((n) => n.appointment_time);
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

/**
 * Create appointment
 * POST /scheduling/api/appointments
 * body: { serviceType: 'delivery'|'notary', date: 'YYYY-MM-DD', time: 'HH:MM', customerId?, orderId? }
 */
router.post('/api/appointments', async (req, res) => {
  const { serviceType = 'delivery', date, time, customerId, orderId } = req.body || {};
  if (!date || !time) return res.status(400).json({ error: 'date and time are required' });

  try {
    // check conflict
    let conflict;
    if (serviceType === 'delivery') {
      const { data, error } = await supabase
        .from('deliveries')
        .select('id')
        .eq('delivery_date', date)
        .eq('delivery_time', time)
        .neq('status', 'cancelled')
        .limit(1);
      if (error) throw error;
      conflict = (data || []).length > 0;
    } else {
      const { data, error } = await supabase
        .from('notary_appointments')
        .select('id')
        .eq('appointment_date', date)
        .eq('appointment_time', time)
        .neq('status', 'cancelled')
        .limit(1);
      if (error) throw error;
      conflict = (data || []).length > 0;
    }
    if (conflict) return res.status(409).json({ error: 'Time slot is not available' });

    // insert
    if (serviceType === 'delivery') {
      const { data, error } = await supabase
        .from('deliveries')
        .insert({
          delivery_date: date,
          delivery_time: time,
          customer_id: customerId || null,
          order_id: orderId || null,
          status: 'confirmed',
          created_at: new Date().toISOString()
        })
        .select()
        .single();
      if (error) throw error;
      return res.status(201).json({ success: true, appointment: data });
    } else {
      const { data, error } = await supabase
        .from('notary_appointments')
        .insert({
          appointment_date: date,
          appointment_time: time,
          customer_id: customerId || null,
          order_id: orderId || null,
          status: 'confirmed',
          created_at: new Date().toISOString()
        })
        .select()
        .single();
      if (error) throw error;
      return res.status(201).json({ success: true, appointment: data });
    }
  } catch (err) {
    console.error('❌ create-appointment error:', err);
    res.status(500).json({ error: 'Failed to create appointment', details: err.message });
  }
});

/**
 * Reschedule appointment
 * PATCH /scheduling/api/appointments/:id
 * body: { serviceType, date, time }
 */
router.patch('/api/appointments/:id', async (req, res) => {
  const { id } = req.params;
  const { serviceType = 'delivery', date, time } = req.body || {};
  if (!date || !time) return res.status(400).json({ error: 'date and time are required' });
  try {
    // conflict check
    let conflict;
    if (serviceType === 'delivery') {
      const { data, error } = await supabase
        .from('deliveries')
        .select('id')
        .eq('delivery_date', date)
        .eq('delivery_time', time)
        .neq('status', 'cancelled')
        .limit(1);
      if (error) throw error;
      conflict = (data || []).length > 0;
      if (conflict) return res.status(409).json({ error: 'Time slot is not available' });
      const { data: updated, error: uerr } = await supabase
        .from('deliveries')
        .update({ delivery_date: date, delivery_time: time, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();
      if (uerr) throw uerr;
      return res.json({ success: true, appointment: updated });
    } else {
      const { data, error } = await supabase
        .from('notary_appointments')
        .select('id')
        .eq('appointment_date', date)
        .eq('appointment_time', time)
        .neq('status', 'cancelled')
        .limit(1);
      if (error) throw error;
      conflict = (data || []).length > 0;
      if (conflict) return res.status(409).json({ error: 'Time slot is not available' });
      const { data: updated, error: uerr } = await supabase
        .from('notary_appointments')
        .update({ appointment_date: date, appointment_time: time, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();
      if (uerr) throw uerr;
      return res.json({ success: true, appointment: updated });
    }
  } catch (err) {
    console.error('❌ reschedule-appointment error:', err);
    res.status(500).json({ error: 'Failed to reschedule appointment', details: err.message });
  }
});

/**
 * Cancel appointment
 * DELETE /scheduling/api/appointments/:id
 * body: { serviceType, reason? }
 */
router.delete('/api/appointments/:id', async (req, res) => {
  const { id } = req.params;
  const { serviceType = 'delivery', reason = 'Cancelled by customer' } = req.body || {};
  try {
    if (serviceType === 'delivery') {
      const { data, error } = await supabase
        .from('deliveries')
        .update({ status: 'cancelled', cancellation_reason: reason, cancelled_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return res.json({ success: true, appointment: data });
    } else {
      const { data, error } = await supabase
        .from('notary_appointments')
        .update({ status: 'cancelled', cancellation_reason: reason, cancelled_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return res.json({ success: true, appointment: data });
    }
  } catch (err) {
    console.error('❌ cancel-appointment error:', err);
    res.status(500).json({ error: 'Failed to cancel appointment', details: err.message });
  }
});

module.exports = router;

