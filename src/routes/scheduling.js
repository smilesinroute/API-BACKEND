// src/routes/scheduling.js
const express = require('express');
const router = express.Router();
const pool = require('../utils/db');

// GET /api/scheduling/available/:date?serviceType=delivery
router.get('/available/:date', async (req, res, next) => {
  try {
    const { date } = req.params;
    const serviceType = req.query.serviceType || 'delivery';

    // Fetch confirmed bookings for the date
    const { rows: bookings } = await pool.query(
      `SELECT time_slot FROM scheduled_appointments WHERE scheduled_date = $1 AND status = 'confirmed'`,
      [date]
    );

    const existingSlots = bookings.map(r => r.time_slot);
    const availableSlots = generateTimeSlots(date, serviceType, existingSlots);

    res.status(200).json({ date, serviceType, availableSlots });
  } catch (err) {
    next(err);
  }
});

// POST /api/scheduling/schedule-appointment
router.post('/schedule-appointment', async (req, res, next) => {
  try {
    const {
      orderId,
      customerId,
      serviceType,
      scheduledDate,
      timeSlot,
      customerInfo,
      serviceDetails
    } = req.body;

    if (!orderId || !customerId || !serviceType || !scheduledDate || !timeSlot) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Check for time slot conflict
    const { rows: conflict } = await pool.query(
      `SELECT id FROM scheduled_appointments WHERE scheduled_date=$1 AND time_slot=$2 AND status='confirmed'`,
      [scheduledDate, timeSlot]
    );

    if (conflict.length > 0) {
      return res.status(409).json({ error: 'Time slot is no longer available' });
    }

    // Insert new appointment
    const { rows } = await pool.query(
      `INSERT INTO scheduled_appointments 
        (order_id, customer_id, service_type, scheduled_date, time_slot, customer_info, service_details, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'confirmed',NOW()) RETURNING *`,
      [orderId, customerId, serviceType, scheduledDate, timeSlot, customerInfo || {}, serviceDetails || {}]
    );

    // Optionally update order status
    await pool.query(
      `UPDATE orders SET scheduled_date=$1, scheduled_time=$2, status='scheduled' WHERE order_id=$3`,
      [scheduledDate, timeSlot, orderId]
    );

    res.status(201).json({ success: true, appointment: rows[0] });
  } catch (err) {
    next(err);
  }
});

// Helper: Generate time slots
function generateTimeSlots(date, serviceType, existing = []) {
  const dayOfWeek = new Date(date).getDay();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const businessHours = isWeekend ? { start: 9, end: 16 } : { start: 8, end: 18 };
  const interval = serviceType === 'notary' ? 60 : 30;
  const slots = [];

  for (let hour = businessHours.start; hour < businessHours.end; hour++) {
    for (let minute = 0; minute < 60; minute += interval) {
      const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      if (!existing.includes(time)) {
        slots.push({ time, available: true });
      }
    }
  }

  return slots;
}

module.exports = router;
