const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const router = express.Router();

// Middleware (applied to this router)
router.use(cors());
router.use(express.json());

// Health check
router.get('/', (req, res) => {
  res.json({ status: 'Scheduling API is running', timestamp: new Date().toISOString() });
});

// Get available time slots for a specific date
router.get('/api/available-slots/:date', async (req, res) => {
  try {
    const { date } = req.params;
    const { serviceType = 'delivery' } = req.query;

    // Validate date
    const requestedDate = new Date(date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (requestedDate < today) {
      return res.status(400).json({ 
        error: 'Cannot schedule for past dates' 
      });
    }

    // Get existing bookings for this date
    const { data: existingBookings, error } = await supabase
      .from('scheduled_appointments')
      .select('time_slot, service_type')
      .eq('scheduled_date', date)
      .eq('status', 'confirmed');

    if (error) {
      throw error;
    }

    // Generate available time slots
    const availableSlots = generateTimeSlots(date, serviceType, existingBookings);

    res.json({
      date,
      serviceType,
      availableSlots,
      totalSlots: availableSlots.length,
      bookedSlots: existingBookings.length
    });

  } catch (error) {
    console.error('Error fetching available slots:', error);
    res.status(500).json({ 
      error: 'Failed to fetch available slots',
      details: error.message 
    });
  }
});

// Create a new appointment
router.post('/api/schedule-appointment', async (req, res) => {
  try {
    const {
      orderId,
      customerId,
      serviceType,
      scheduledDate,
      timeSlot,
      customerInfo,
      serviceDetails,
      specialInstructions,
      rushService = false
    } = req.body;

    // Validate required fields
    if (!orderId || !customerId || !serviceType || !scheduledDate || !timeSlot) {
      return res.status(400).json({ 
        error: 'Missing required fields' 
      });
    }

    // Check if time slot is still available
    const { data: existingAppointment } = await supabase
      .from('scheduled_appointments')
      .select('id')
      .eq('scheduled_date', scheduledDate)
      .eq('time_slot', timeSlot)
      .eq('status', 'confirmed')
      .single();

    if (existingAppointment) {
      return res.status(409).json({ 
        error: 'Time slot is no longer available' 
      });
    }

    // Create the appointment
    const { data: appointment, error } = await supabase
      .from('scheduled_appointments')
      .insert({
        order_id: orderId,
        customer_id: customerId,
        service_type: serviceType,
        scheduled_date: scheduledDate,
        time_slot: timeSlot,
        customer_info: customerInfo,
        service_details: serviceDetails,
        special_instructions: specialInstructions,
        rush_service: rushService,
        status: 'confirmed',
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) {
      throw error;
    }

    // Update the order with scheduling information
    await supabase
      .from('orders')
      .update({
        scheduled_date: scheduledDate,
        scheduled_time: timeSlot,
        status: 'scheduled'
      })
      .eq('id', orderId);

    res.json({
      success: true,
      appointment: {
        id: appointment.id,
        scheduledDate,
        timeSlot,
        serviceType,
        status: 'confirmed'
      }
    });

  } catch (error) {
    console.error('Error creating appointment:', error);
    res.status(500).json({ 
      error: 'Failed to create appointment',
      details: error.message 
    });
  }
});

// Update an existing appointment
router.put('/api/appointment/:appointmentId', async (req, res) => {
  try {
    const { appointmentId } = req.params;
    const updates = req.body;

    // If rescheduling, check new time slot availability
    if (updates.scheduledDate && updates.timeSlot) {
      const { data: conflictingAppointment } = await supabase
        .from('scheduled_appointments')
        .select('id')
        .eq('scheduled_date', updates.scheduledDate)
        .eq('time_slot', updates.timeSlot)
        .eq('status', 'confirmed')
        .neq('id', appointmentId)
        .single();

      if (conflictingAppointment) {
        return res.status(409).json({ 
          error: 'New time slot is not available' 
        });
      }
    }

    const { data: appointment, error } = await supabase
      .from('scheduled_appointments')
      .update({
        ...updates,
        updated_at: new Date().toISOString()
      })
      .eq('id', appointmentId)
      .select()
      .single();

    if (error) {
      throw error;
    }

    res.json({
      success: true,
      appointment
    });

  } catch (error) {
    console.error('Error updating appointment:', error);
    res.status(500).json({ 
      error: 'Failed to update appointment',
      details: error.message 
    });
  }
});

// Cancel an appointment
router.delete('/api/appointment/:appointmentId', async (req, res) => {
  try {
    const { appointmentId } = req.params;
    const { reason = 'Customer cancellation' } = req.body;

    const { data: appointment, error } = await supabase
      .from('scheduled_appointments')
      .update({
        status: 'cancelled',
        cancellation_reason: reason,
        cancelled_at: new Date().toISOString()
      })
      .eq('id', appointmentId)
      .select()
      .single();

    if (error) {
      throw error;
    }

    // Update related order status
    if (appointment.order_id) {
      await supabase
        .from('orders')
        .update({
          status: 'cancelled',
          cancelled_at: new Date().toISOString()
        })
        .eq('id', appointment.order_id);
    }

    res.json({
      success: true,
      message: 'Appointment cancelled successfully'
    });

  } catch (error) {
    console.error('Error cancelling appointment:', error);
    res.status(500).json({ 
      error: 'Failed to cancel appointment',
      details: error.message 
    });
  }
});

// Get appointment details
router.get('/api/appointment/:appointmentId', async (req, res) => {
  try {
    const { appointmentId } = req.params;

    const { data: appointment, error } = await supabase
      .from('scheduled_appointments')
      .select(`
        *,
        orders (
          id,
          pickup_address,
          delivery_address,
          service_type,
          total_amount
        )
      `)
      .eq('id', appointmentId)
      .single();

    if (error) {
      throw error;
    }

    res.json({
      success: true,
      appointment
    });

  } catch (error) {
    console.error('Error fetching appointment:', error);
    res.status(500).json({ 
      error: 'Failed to fetch appointment',
      details: error.message 
    });
  }
});

// Get customer's appointments
router.get('/api/customer/:customerId/appointments', async (req, res) => {
  try {
    const { customerId } = req.params;
    const { status, limit = 10, offset = 0 } = req.query;

    let query = supabase
      .from('scheduled_appointments')
      .select(`
        *,
        orders (
          id,
          pickup_address,
          delivery_address,
          service_type,
          total_amount
        )
      `)
      .eq('customer_id', customerId)
      .order('scheduled_date', { ascending: true })
      .range(offset, offset + limit - 1);

    if (status) {
      query = query.eq('status', status);
    }

    const { data: appointments, error } = await query;

    if (error) {
      throw error;
    }

    res.json({
      success: true,
      appointments,
      total: appointments.length
    });

  } catch (error) {
    console.error('Error fetching customer appointments:', error);
    res.status(500).json({ 
      error: 'Failed to fetch appointments',
      details: error.message 
    });
  }
});

// Helper function to generate time slots
function generateTimeSlots(date, serviceType, existingBookings = []) {
  const dayOfWeek = new Date(date).getDay();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  
  // Business hours
  const businessHours = {
    weekday: { start: 8, end: 18 },
    weekend: { start: 9, end: 16 }
  };
  
  const hours = isWeekend ? businessHours.weekend : businessHours.weekday;
  const interval = serviceType === 'notary' ? 60 : 30; // 60min for notary, 30min for delivery
  
  const slots = [];
  const bookedTimes = existingBookings.map(booking => booking.time_slot);
  
  for (let hour = hours.start; hour < hours.end; hour++) {
    for (let minute = 0; minute < 60; minute += interval) {
      const timeString = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
      
      if (!bookedTimes.includes(timeString)) {
        let label = 'Standard';
        let additionalFee = 0;
        
        if (serviceType === 'delivery') {
          if (hour < 10) {
            label = 'Early Morning';
            additionalFee = 5;
          } else if (hour >= 17) {
            label = 'Evening';
            additionalFee = 3;
          }
        } else if (serviceType === 'notary') {
          if (hour < 9 || hour >= 17) {
            label = 'Premium Time';
            additionalFee = 25;
          }
        }
        
        slots.push({
          time: timeString,
          label,
          additionalFee,
          available: true
        });
      }
    }
  }
  
  return slots;
}

module.exports = router;

// Removed standalone app/server and app.listen to ensure server.js is the only entry.
