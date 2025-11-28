// apps/api/src/services/schedulingService.js
const { v4: uuidv4 } = require('uuid');
const { insertAppointment, findAppointmentsByDate, getAppointmentById, updateAppointmentById } = require('../db/queries');

function generateTimeSlots(date, serviceType = 'delivery', existingBookings = []) {
  const dayOfWeek = new Date(date).getDay();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const hours = isWeekend ? { start: 9, end: 16 } : { start: 8, end: 18 };
  const interval = serviceType === 'notary' ? 60 : 30;

  const booked = new Set((existingBookings || []).map(b => b.time_slot));

  const slots = [];
  for (let h = hours.start; h < hours.end; h++) {
    for (let m = 0; m < 60; m += interval) {
      const timeString = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      if (!booked.has(timeString)) {
        slots.push({ time: timeString, available: true });
      }
    }
  }
  return slots;
}

async function getAvailableSlots(date, serviceType) {
  // in production query DB for existing bookings
  const existing = await findAppointmentsByDate(date).catch(() => []);
  return generateTimeSlots(date, serviceType, existing);
}

async function createAppointment(payload) {
  const id = `appt_${Date.now()}_${uuidv4().slice(0, 6)}`;
  const record = {
    id,
    customer_id: payload.customerId || null,
    order_id: payload.orderId || null,
    service_type: payload.serviceType,
    scheduled_date: payload.scheduledDate,
    time_slot: payload.timeSlot,
    customer_info: payload.customerInfo || {},
    service_details: payload.serviceDetails || {},
    status: 'confirmed',
    created_at: new Date().toISOString()
  };

  await insertAppointment(record);
  return record;
}

async function updateAppointment(id, updates) {
  return updateAppointmentById(id, updates);
}

async function cancelAppointment(id, reason = 'Cancelled by customer') {
  return updateAppointmentById(id, { status: 'cancelled', cancellation_reason: reason, cancelled_at: new Date().toISOString() });
}

module.exports = {
  getAvailableSlots,
  createAppointment,
  updateAppointment,
  cancelAppointment,
  generateTimeSlots
};

