"use strict";

const { TIME_ZONE, pacificNow, validDate, badRequest } = require("./courierSchedule");

const TIMES = [
  { value: "09:00", label: "9 AM" }, { value: "10:30", label: "10:30 AM" },
  { value: "12:00", label: "12 PM" }, { value: "13:30", label: "1:30 PM" },
  { value: "15:00", label: "3 PM" }, { value: "16:30", label: "4:30 PM" },
];
const DOCUMENTS = ["General document", "Real estate", "Power of attorney", "Affidavit", "Business document", "Other"];
const LOCATIONS = { house: "House", apartment: "Apartment / condo", business: "Business", other: "Other" };

function text(value, label, max, required = true) {
  if (value != null && typeof value !== "string") throw badRequest(`Please enter a valid ${label}.`);
  const result = String(value ?? "").trim();
  if ((required && !result) || result.length > max) throw badRequest(`Please enter a valid ${label}.`);
  return result;
}

function address(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest(`Please enter the ${label}.`);
  const street = text(value.street, `${label} street`, 250);
  const city = text(value.city, `${label} city`, 100);
  const state = text(value.state, `${label} state`, 2).toUpperCase();
  const zip = text(value.zip, `${label} ZIP code`, 10);
  const unit = text(value.unit, `${label} unit`, 100, false);
  if (!/^[A-Z]{2}$/.test(state) || !/^\d{5}(-\d{4})?$/.test(zip)) throw badRequest(`Please enter a valid ${label} state and ZIP code.`);
  return { state, zip, formatted: `${street}${unit ? `, ${unit}` : ""}, ${city}, ${state} ${zip}` };
}

function getNotarySchedule(date, now = new Date()) {
  if (!validDate(date)) throw badRequest("Choose a valid appointment date.");
  const today = pacificNow(now);
  if (date < today.date) throw badRequest("Appointment dates cannot be in the past.");
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  const weekday = day > 0 && day < 6;
  const times = weekday ? TIMES.filter(slot => date > today.date || slot.value > today.time) : [];
  return { times, timezone: TIME_ZONE, today: today.date, service_type: "notary",
    appointmentOnly: true, requiresConfirmation: true,
    operatingHours: "Monday–Friday, 9 AM–6 PM Pacific",
    message: !weekday ? "We schedule appointments Monday–Friday. Please choose a weekday."
      : times.length ? "Choose a preferred time. Dispatch must confirm the appointment and quote."
      : "Today's appointment times have started. Please choose another weekday." };
}

async function createNotaryRequest(pool, body, now = new Date()) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("Please enter valid request details.");
  if (body.region !== "oregon") throw badRequest("Online notary requests are currently available in Oregon only.");
  const name = text(body.customer_name, "customer name", 160);
  const email = text(body.customer_email, "email address", 254).toLowerCase();
  const phone = text(body.customer_phone, "phone number", 40);
  const businessPhone = text(body.business_phone, "business phone", 40, false);
  if (businessPhone && businessPhone.replace(/\D/g, "").length < 10) throw badRequest("Please enter a valid business phone number.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest("Please enter a valid email address.");
  if (phone.replace(/\D/g, "").length < 10) throw badRequest("Please enter a valid phone number.");
  const customerAddress = address(body.customer_address, "customer address");
  const signingAddress = address(body.appointment_address, "appointment address");
  if (signingAddress.state !== "OR" || !/^97/.test(signingAddress.zip)) throw badRequest("The appointment address must be in Oregon.");
  const location = body.appointment_location;
  if (!location || !Object.hasOwn(LOCATIONS, location.locationType)) throw badRequest("Choose the appointment location type.");
  const business = location.locationType === "business" ? text(location.businessName, "business name", 160) : "";
  const description = location.locationType === "other" ? text(location.description, "location description", 160) : "";
  const instructions = text(location.instructions, "arrival instructions", 500, false);
  const category = text(body.document_type, "document type", 40);
  if (!DOCUMENTS.includes(category)) throw badRequest("Choose a valid document type.");
  const documentType = category === "Other" ? `Other: ${text(body.document_type_other, "document description", 160)}` : category;
  if (!Number.isInteger(body.signers) || body.signers < 1 || body.signers > 50) throw badRequest("Enter between 1 and 50 signers.");
  if (!Number.isInteger(body.documents) || body.documents < 1 || body.documents > 100) throw badRequest("Enter between 1 and 100 documents.");
  if (body.time_sensitive !== undefined && typeof body.time_sensitive !== "boolean") throw badRequest("Choose a valid handling preference.");
  const notes = text(body.notes, "notes", 1000, false);
  const schedule = getNotarySchedule(body.scheduled_date, now);
  const time = schedule.times.find(slot => slot.value === body.scheduled_time);
  if (!time) throw badRequest("That appointment time is no longer requestable. Please choose another time.");
  const dispatchNotes = [
    "NOTARY APPOINTMENT REQUEST — awaiting dispatch confirmation; no time is reserved.",
    "QUOTE REQUIRED — notary and travel fees must be confirmed before payment. No amount has been agreed.",
    `Customer phone: ${phone}`, businessPhone && `Business phone: ${businessPhone}`, `Requested appointment: ${body.scheduled_date}, ${time.label} (${TIME_ZONE})`,
    `Location type: ${LOCATIONS[location.locationType]}`, business && `Business: ${business}`,
    description && `Location: ${description}`, instructions && `Arrival: ${instructions}`,
    `Documents: ${body.documents}`, `Signers: ${body.signers}`,
    body.time_sensitive && "Time-sensitive request: dispatch must confirm the deadline.",
    notes && `Customer notes: ${notes}`,
  ].filter(Boolean).join("\n");
  // Intentionally unpriced. Existing admin approval rejects null/zero totals,
  // so a request cannot create a payment link until an amount is established.
  const { rows } = await pool.query(`
    INSERT INTO public.orders (
      service_type, region, customer_name, customer_email, pickup_address,
      id_address, signers, document_type, scheduled_date, scheduled_time,
      notes, total_amount, pricing_breakdown, status, payment_status
    ) VALUES ('notary','oregon',$1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10,
      'pending_admin_review','unpaid')
    RETURNING id, status, payment_status, scheduled_date::text, scheduled_time::text
  `, [name, email, signingAddress.formatted, customerAddress.formatted, body.signers,
    documentType, body.scheduled_date, time.value, dispatchNotes,
    JSON.stringify({ quoteRequired: true, documents: body.documents, signers: body.signers })]);
  if (!rows[0]?.id) throw new Error("Request was not saved.");
  return { ...rows[0], service_type: "notary", total_amount: null, quote_required: true,
    requested_time: time, timezone: TIME_ZONE, requiresConfirmation: true,
    customer_name: name, customer_email: email, pickup_address: signingAddress.formatted, notes: dispatchNotes };
}

module.exports = { getNotarySchedule, createNotaryRequest };
