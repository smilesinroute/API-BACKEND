const nodemailer = require('nodemailer');

/**
 * Send payment request email with Stripe checkout link
 */
async function sendPaymentEmail({
  to,
  customerName,
  serviceType,
  pickup,
  delivery,
  date,
  time,
  distance,
  total,
  checkoutUrl,
}) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: false, // TLS via STARTTLS (Zoho)
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const subject =
    serviceType === 'mobile_notary'
      ? 'Action Required: Complete Your Mobile Notary Booking'
      : 'Action Required: Complete Your Delivery Booking';

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 640px;">
      <h2 style="color:#0f766e;">Smiles in Route Transportation</h2>

      <p>Hello ${customerName},</p>

      <p>
        Your ${serviceType === 'mobile_notary' ? 'mobile notary appointment' : 'delivery'}
        has been scheduled. Please review the details below.
      </p>

      <table cellpadding="6">
        <tr><td><strong>Pickup:</strong></td><td>${pickup}</td></tr>
        <tr><td><strong>Drop-off:</strong></td><td>${delivery}</td></tr>
        <tr><td><strong>Date:</strong></td><td>${date}</td></tr>
        <tr><td><strong>Time:</strong></td><td>${time}</td></tr>
        <tr><td><strong>Distance:</strong></td><td>${distance} miles</td></tr>
        <tr><td><strong>Total:</strong></td><td>$${total}</td></tr>
      </table>

      <p style="margin-top:16px;">
        To confirm and lock in your booking, please complete payment using the secure link below:
      </p>

      <p>
        <a href="${checkoutUrl}"
           style="display:inline-block;padding:12px 18px;background:#0f766e;color:#fff;
                  text-decoration:none;border-radius:6px;font-weight:bold;">
          Pay Securely Now
        </a>
      </p>

      <p style="font-size:12px;color:#555;margin-top:20px;">
        This payment link is unique to your order and will expire if not completed.
        No charges will be made until you submit payment.
      </p>

      <p>
        —<br/>
        Smiles in Route Transportation<br/>
        <a href="mailto:billing@smilesinroute.delivery">billing@smilesinroute.delivery</a>
      </p>
    </div>
  `;

  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to,
    subject,
    html,
  });
}

module.exports = { sendPaymentEmail };
