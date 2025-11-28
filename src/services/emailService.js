// apps/api/src/services/emailService.js
const nodemailer = require('nodemailer');
require('dotenv').config();

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || 'smtp.gmail.com',
  port: process.env.EMAIL_PORT ? parseInt(process.env.EMAIL_PORT) : 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// send basic booking email
async function sendBookingRequestEmail(booking, customerInfo) {
  if (!process.env.EMAIL_USER) {
    console.warn('EMAIL_USER not set - skipping sending booking email (dev mode)');
    return;
  }

  const html = `
    <p>Hi ${customerInfo.name},</p>
    <p>Thanks — we received your booking request. Booking ID: <strong>${booking.id}</strong></p>
    <p>Total: $${booking.total_price}</p>
    <p>We'll notify you when payment is confirmed.</p>
  `;

  const mailOptions = {
    from: `"Smiles in Route" <${process.env.EMAIL_USER}>`,
    to: customerInfo.email,
    subject: `Booking request received — ${booking.id}`,
    html
  };

  return transporter.sendMail(mailOptions);
}

module.exports = {
  sendBookingRequestEmail
};
