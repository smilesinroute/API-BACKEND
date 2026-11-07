"use strict";

const { calculateQuote } = require("../routes/quote");
const { requireCourierWindow, TIME_ZONE, badRequest } = require("./courierSchedule");

const LOCATION_TYPES = { house: "House", apartment: "Apartment / condo", business: "Business", other: "Other" };

function text(value, label, max, required = true) {
  if (value !== undefined && value !== null && typeof value !== "string") throw badRequest(`${label} must be text.`);
  const result = String(value ?? "").trim();
  if ((required && !result) || result.length > max) throw badRequest(`Please enter a valid ${label.toLowerCase()}.`);
  return result;
}

function location(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest(`Choose the ${label.toLowerCase()} location type.`);
  const type = text(value.locationType, `${label} location type`, 20);
  if (!Object.hasOwn(LOCATION_TYPES, type)) throw badRequest(`Choose the ${label.toLowerCase()} location type.`);
  return {
    locationType: type,
    businessName: type === "business" ? text(value.businessName, `${label} business name`, 160) : "",
    description: type === "other" ? text(value.description, `${label} location description`, 160) : "",
    unit: text(value.unit, `${label} unit or suite`, 100, false),
    instructions: text(value.instructions, `${label} arrival instructions`, 500, false),
  };
}

function stopNotes(label, stop) {
  return [
    `${label} type: ${LOCATION_TYPES[stop.locationType]}`,
    stop.businessName && `${label} business: ${stop.businessName}`,
    stop.description && `${label} description: ${stop.description}`,
    stop.unit && `${label} unit/suite: ${stop.unit}`,
    stop.instructions && `${label} arrival instructions: ${stop.instructions}`,
  ].filter(Boolean);
}

async function createCourierRequest(pool, body, now = new Date()) {
  if (!body || body.service_type !== "courier") throw badRequest("This endpoint accepts courier requests only.");
  if (body.region !== "oregon") throw badRequest("Online appointment requests are currently available for Oregon only.");
  const name = text(body.customer_name, "Customer name", 160);
  const email = text(body.customer_email, "Customer email", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest("Please enter a valid customer email.");
  const phone = text(body.customer_phone, "Customer phone number", 40);
  if (phone.replace(/\D/g, "").length < 10) throw badRequest("Please enter a valid customer phone number.");
  const pickupAddress = text(body.pickup_address, "Pickup address", 700);
  const deliveryAddress = text(body.delivery_address, "Delivery address", 700);
  const pickup = location(body.pickup_details, "Pickup");
  const delivery = location(body.delivery_details, "Delivery");
  if (!["sedan", "cargo"].includes(body.vehicle_type)) throw badRequest("Choose a valid vehicle type.");
  const options = body.options ?? {};
  if (typeof options !== "object" || Array.isArray(options)) throw badRequest("Choose valid service options.");
  for (const flag of ["fragile", "priority", "timeSensitive"]) {
    if (options[flag] !== undefined && typeof options[flag] !== "boolean") throw badRequest("Choose valid service options.");
  }
  const window = requireCourierWindow(body.scheduled_date, body.scheduled_time, now);
  const deadline = text(body.delivery_deadline, "Delivery deadline", 5, false);
  if (deadline && (!/^([01]\d|2[0-3]):[0-5]\d$/.test(deadline) || deadline < window.value || deadline > "18:00")) {
    throw badRequest("Delivery deadlines must fall after the pickup window starts and by 6 PM Pacific that day.");
  }

  // Recalculate with current stored prices and Google distance; never trust the
  // browser's price, mileage or breakdown when creating a billable request.
  const quote = await calculateQuote(pool, {
    serviceType: "courier", region: "oregon", vehicleType: body.vehicle_type,
    pickupAddress, dropoffAddress: deliveryAddress,
    fragile: options.fragile === true, priority: options.priority === true,
    timeSensitive: options.timeSensitive === true,
  });
  if (!Number.isFinite(quote.distance) || quote.distance <= 0 || !Number.isFinite(quote.total) || quote.total <= 0) {
    throw Object.assign(new Error("Unable to verify a valid quote. Please review your addresses."), { statusCode: 502 });
  }
  if (typeof body.total_amount !== "number" || !Number.isFinite(body.total_amount) || Math.abs(body.total_amount - quote.total) > 0.001) {
    throw Object.assign(new Error("Prices have changed. Go back to service options and request a new quote."), { statusCode: 409 });
  }

  const notes = [
    "APPOINTMENT REQUEST — awaiting dispatch confirmation; no time is reserved yet.",
    `Customer phone: ${phone}`,
    `Requested pickup: ${body.scheduled_date}, ${window.label} (${TIME_ZONE})`,
    deadline && `Requested delivery deadline: ${body.scheduled_date} ${deadline} (${TIME_ZONE}); subject to confirmation`,
    ...stopNotes("Pickup", pickup), ...stopNotes("Delivery", delivery),
  ].filter(Boolean).join("\n");

  const { rows } = await pool.query(`
    INSERT INTO public.orders (
      service_type, region, customer_name, customer_email, pickup_address,
      delivery_address, distance_miles, vehicle_type, scheduled_date,
      scheduled_time, total_amount, notes, pricing_breakdown, status, payment_status
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
      'pending_admin_review','unpaid')
    RETURNING id, status, payment_status, scheduled_date::text, scheduled_time::text, total_amount
  `, ["courier", "oregon", name, email, pickupAddress, deliveryAddress, quote.distance,
    body.vehicle_type, body.scheduled_date, window.value, quote.total, notes, JSON.stringify(quote.breakdown)]);
  if (!rows[0]?.id) throw new Error("Request was not saved.");
  return { ...rows[0], pickup_address: pickupAddress, delivery_address: deliveryAddress,
    customer_name: name, customer_email: email, notes, requested_window: window, timezone: TIME_ZONE };
}

module.exports = { createCourierRequest };
