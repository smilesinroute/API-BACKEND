const nodemailer = require('nodemailer');

/**
 * Sends a payment request email with a Stripe Checkout link.
 * This function MUST NOT throw in a way that breaks the order flow.
 */
async function sendPaymentEmail({
  to,
  customerName = 'Customer',
  serviceType,
  pickup,
  delivery,
  date,
  time,
  distance,
  total,
  checkoutUrl,
}) {
  if (!to || !checkoutUrl) {
    console.warn('[EMAIL] Missing recipient or checkout URL — email skipped');
    return;
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false, // STARTTLS (Zoho)
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const isNotary = serviceType === 'mobile_notary';

  const subject = isNotary
    ? 'Action Required: Complete Your Mobile Notary Appointment'
    : 'Action Required: Complete Your Delivery Booking';

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 640px; line-height: 1.5;">
      <h2 style="color:#0f766e;">Smiles in Route Transportation</h2>

      <p>Hello ${customerName},</p>

      <p>
        Your <strong>${isNotary ? 'mobile notary appointment' : 'delivery'}</strong>
        has been scheduled. Please review the details below and complete payment to confirm.
      </p>

      <table cellpadding="6" style="border-collapse: collapse;">
        ${pickup ? `<tr><td><strong>Pickup:</strong></td><td>${pickup}</td></tr>` : ''}
        ${delivery ? `<tr><td><strong>Drop-off:</strong></td><td>${delivery}</td></tr>` : ''}
        ${date ? `<tr><td><strong>Date:</strong></td><td>${date}</td></tr>` : ''}
        ${time ? `<tr><td><strong>Time:</strong></td><td>${time}</td></tr>` : ''}
        ${distance ? `<tr><td><strong>Distance:</strong></td><td>${distance} miles</td></tr>` : ''}
        <tr><td><strong>Total:</strong></td><td><strong>$${total}</strong></td></tr>
      </table>

      <p style="margin-top:16px;">
        To confirm and lock in your booking, please complete payment using the secure link below:
      </p>

      <p>
        <a href="${checkoutUrl}"
           style="
             display:inline-block;
             padding:12px 18px;
             background:#0f766e;
             color:#ffffff;
             text-decoration:none;
             border-radius:6px;
             font-weight:bold;
           ">
          Pay Securely Now
        </a>
      </p>

      <p style="font-size:12px;color:#555;margin-top:20px;">
        This payment link is unique to your order.
        No charges are made until payment is successfully completed.
        If payment is not received, the scheduled time may be released.
      </p>

      <p style="margin-top:20px;">
        —<br/>
        <strong>Smiles in Route Transportation</strong><br/>
        <a href="mailto:billing@smilesinroute.delivery">
          billing@smilesinroute.delivery
        </a>
      </p>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM,
      to,
      subject,
      html,
    });

    console.log('[EMAIL] Payment email sent to:', to);
  } catch (err) {
    // DO NOT THROW — email failure must not break checkout
    console.error('[EMAIL] Failed to send payment email:', err.message);
  }
}

module.exports = { sendPaymentEmail };
