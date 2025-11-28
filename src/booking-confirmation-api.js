// Sample Backend API for Booking Confirmation and Email System
// This would be implemented in your backend (Node.js/Express, Supabase Edge Functions, etc.)

// POST /api/bookings/confirm
// Endpoint to handle booking confirmation and send emails

const express = require('express');
const nodemailer = require('nodemailer');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Configure email transporter (example with Gmail)
const emailTransporter = nodemailer.createTransporter({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_APP_PASSWORD
  }
});

/**
 * Handle booking confirmation request
 */
async function handleBookingConfirmation(req, res) {
  try {
    const { customerInfo, bookingDetails, timestamp } = req.body;
    
    // 1. Create booking record in database
    const bookingId = `booking_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const { data: booking, error: bookingError } = await supabase
      .from('scheduled_appointments')
      .insert([{
        id: bookingId,
        customer_info: customerInfo,
        service_type: bookingDetails.serviceType,
        scheduled_date: bookingDetails.requestedDate,
        time_slot: bookingDetails.requestedTime,
        service_details: {
          fromAddress: bookingDetails.fromAddress,
          toAddress: bookingDetails.toAddress,
          totalPrice: bookingDetails.totalPrice,
          distance: bookingDetails.distance,
          estimatedTime: bookingDetails.estimatedTime,
          urgencyLevel: bookingDetails.urgencyLevel
        },
        special_instructions: customerInfo.specialInstructions,
        status: 'pending_payment',
        rush_service: bookingDetails.urgencyLevel !== 'standard'
      }])
      .select()
      .single();

    if (bookingError) {
      throw new Error(`Database error: ${bookingError.message}`);
    }

    // 2. Create Stripe payment link
    const paymentLink = await stripe.paymentLinks.create({
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `${bookingDetails.urgencyLevel} ${bookingDetails.serviceType} Service`,
              description: `${bookingDetails.fromAddress} → ${bookingDetails.toAddress}`,
              metadata: {
                bookingId: bookingId,
                serviceType: bookingDetails.serviceType,
                urgencyLevel: bookingDetails.urgencyLevel
              }
            },
            unit_amount: Math.round(bookingDetails.totalPrice * 100), // Convert to cents
          },
          quantity: 1,
        },
      ],
      metadata: {
        bookingId: bookingId,
        customerEmail: customerInfo.email,
        customerName: customerInfo.name
      },
      after_completion: {
        type: 'redirect',
        redirect: {
          url: `${process.env.FRONTEND_URL}/booking-success?booking=${bookingId}`
        }
      }
    });

    // 3. Generate email content
    const emailHtml = generateBookingEmailHTML({
      customerInfo,
      bookingDetails,
      bookingId,
      paymentUrl: paymentLink.url
    });

    // 4. Send confirmation email
    const emailOptions = {
      from: `"Smiles in Route" <bookings@smilesinroute.com>`,
      to: customerInfo.email,
      subject: `Booking Confirmation Required - ${bookingId}`,
      html: emailHtml,
      attachments: [
        {
          filename: 'logo.png',
          path: './assets/logo.png',
          cid: 'company-logo'
        }
      ]
    };

    await emailTransporter.sendMail(emailOptions);

    // 5. Send admin notification
    await sendAdminNotification({
      bookingId,
      customerInfo,
      bookingDetails,
      paymentUrl: paymentLink.url
    });

    // 6. Return success response
    res.json({
      success: true,
      bookingId: bookingId,
      paymentUrl: paymentLink.url,
      message: 'Booking confirmation sent successfully'
    });

  } catch (error) {
    console.error('Booking confirmation error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to process booking confirmation'
    });
  }
}

/**
 * Handle Stripe webhook for payment confirmation
 */
async function handleStripeWebhook(req, res) {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle payment success
  if (event.type === 'checkout.session.completed' || event.type === 'payment_intent.succeeded') {
    const session = event.data.object;
    const bookingId = session.metadata?.bookingId;

    if (bookingId) {
      // Update booking status to confirmed
      await supabase
        .from('scheduled_appointments')
        .update({ 
          status: 'confirmed',
          updated_at: new Date().toISOString()
        })
        .eq('id', bookingId);

      // Log payment
      await supabase
        .from('payment_logs')
        .insert([{
          booking_id: bookingId,
          payment_intent_id: session.payment_intent || session.id,
          amount: session.amount_total,
          currency: session.currency,
          status: 'succeeded',
          confirmed_at: new Date().toISOString(),
          metadata: session.metadata
        }]);

      // Send booking confirmation email
      await sendBookingConfirmedEmail(bookingId);
      
      // Notify admin of confirmed booking
      await notifyAdminBookingConfirmed(bookingId);
    }
  }

  res.json({ received: true });
}

/**
 * Generate booking confirmation email HTML
 */
function generateBookingEmailHTML({ customerInfo, bookingDetails, bookingId, paymentUrl }) {
  const formattedDate = new Date(bookingDetails.requestedDate).toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  return `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <title>Booking Confirmation - Smiles in Route</title>
        <style>
            body { font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
            .container { max-width: 600px; margin: 0 auto; }
            .header { background: linear-gradient(135deg, #1e40af, #3b82f6); color: white; padding: 30px; text-align: center; }
            .content { padding: 30px; background: white; }
            .footer { background: #f8fafc; padding: 20px; text-align: center; font-size: 14px; color: #64748b; }
            .button { display: inline-block; padding: 15px 30px; background: #10b981; color: white; text-decoration: none; border-radius: 8px; font-weight: bold; margin: 20px 0; }
            .booking-details { background: #f0f9ff; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #3b82f6; }
            .warning { background: #fef3c7; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #f59e0b; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>🎉 Booking Request Received!</h1>
                <p>Smiles in Route Transportation LLC</p>
            </div>
            
            <div class="content">
                <p>Dear ${customerInfo.name},</p>
                
                <p>Thank you for choosing Smiles in Route! We've received your booking request and are excited to serve you.</p>
                
                <div class="booking-details">
                    <h3>📋 Booking Details</h3>
                    <p><strong>Booking ID:</strong> ${bookingId}</p>
                    <p><strong>Service:</strong> ${bookingDetails.urgencyLevel} ${bookingDetails.serviceType}</p>
                    <p><strong>Date & Time:</strong> ${formattedDate} at ${bookingDetails.requestedTime}</p>
                    <p><strong>Route:</strong> ${bookingDetails.fromAddress} → ${bookingDetails.toAddress}</p>
                    <p><strong>Distance:</strong> ${bookingDetails.distance.toFixed(1)} miles (~${bookingDetails.estimatedTime})</p>
                    <p><strong>Total Cost:</strong> $${bookingDetails.totalPrice}</p>
                </div>
                
                <div class="warning">
                    <h4>⚡ Important: Complete Your Booking</h4>
                    <p>Your booking is <strong>not confirmed</strong> until payment is completed. Please use the secure payment link below.</p>
                </div>
                
                <div style="text-align: center;">
                    <a href="${paymentUrl}" class="button">💳 Complete Payment & Confirm Booking</a>
                </div>
                
                <p><strong>Questions or need changes?</strong><br>
                Call us at <strong>(555) 123-4567</strong> or reply to this email.</p>
                
                <p>Thank you for supporting our local, Black-owned family business!</p>
                
                <p>Best regards,<br>
                <strong>The Smiles in Route Team</strong></p>
            </div>
            
            <div class="footer">
                <p>Smiles in Route Transportation LLC<br>
                📧 bookings@smilesinroute.com | 📞 (555) 123-4567</p>
            </div>
        </div>
    </body>
    </html>
  `;
}

/**
 * Send admin notification of new booking request
 */
async function sendAdminNotification({ bookingId, customerInfo, bookingDetails, paymentUrl }) {
  const adminEmailOptions = {
    from: `"Booking System" <system@smilesinroute.com>`,
    to: process.env.ADMIN_EMAIL,
    subject: `🔔 New Booking Request: ${bookingId}`,
    html: `
      <h2>New Booking Request Received</h2>
      <p><strong>Booking ID:</strong> ${bookingId}</p>
      <p><strong>Customer:</strong> ${customerInfo.name} (${customerInfo.email})</p>
      <p><strong>Service:</strong> ${bookingDetails.urgencyLevel} ${bookingDetails.serviceType}</p>
      <p><strong>Date:</strong> ${bookingDetails.requestedDate} at ${bookingDetails.requestedTime}</p>
      <p><strong>Route:</strong> ${bookingDetails.fromAddress} → ${bookingDetails.toAddress}</p>
      <p><strong>Amount:</strong> $${bookingDetails.totalPrice}</p>
      <p><strong>Payment Link:</strong> <a href="${paymentUrl}">View Payment Link</a></p>
      
      <p><em>Customer has been sent confirmation email with payment link.</em></p>
    `
  };

  await emailTransporter.sendMail(adminEmailOptions);
}

module.exports = {
  handleBookingConfirmation,
  handleStripeWebhook,
  generateBookingEmailHTML
};

/* 
ENVIRONMENT VARIABLES NEEDED:
- STRIPE_SECRET_KEY
- STRIPE_WEBHOOK_SECRET
- SUPABASE_URL
- SUPABASE_SERVICE_KEY
- EMAIL_USER
- EMAIL_APP_PASSWORD
- ADMIN_EMAIL
- FRONTEND_URL
*/
