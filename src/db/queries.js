// apps/api/src/db/queries.js
const supabase = require('./pool');

// Insert booking
async function insertBooking(bookingRecord) {
  if (!supabase) throw new Error('DB not configured');
  const { data, error } = await supabase.from('bookings').insert([bookingRecord]).select().single();
  if (error) throw error;
  return data;
}

// Appointment helpers
async function insertAppointment(appt) {
  const { data, error } = await supabase.from('scheduled_appointments').insert([appt]).select().single();
  if (error) throw error;
  return data;
}

async function findAppointmentsByDate(date) {
  const { data, error } = await supabase.from('scheduled_appointments').select('time_slot').eq('scheduled_date', date).eq('status', 'confirmed');
  if (error) throw error;
  return data || [];
}

async function getAppointmentById(id) {
  const { data, error } = await supabase.from('scheduled_appointments').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

async function updateAppointmentById(id, updates) {
  const { data, error } = await supabase.from('scheduled_appointments').update(updates).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

module.exports = {
  insertBooking,
  insertAppointment,
  findAppointmentsByDate,
  getAppointmentById,
  updateAppointmentById
};

