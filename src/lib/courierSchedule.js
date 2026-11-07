"use strict";

const TIME_ZONE = "America/Los_Angeles";
const WINDOWS = [
  { value: "09:00", end: "12:00", label: "9 AM–12 PM" },
  { value: "12:00", end: "15:00", label: "12–3 PM" },
  { value: "15:00", end: "18:00", label: "3–6 PM" },
];

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function pacificNow(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function validDate(date) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function getCourierSchedule(date, now = new Date()) {
  if (!validDate(date)) throw badRequest("Choose a valid pickup date.");
  const today = pacificNow(now);
  if (date < today.date) throw badRequest("Pickup dates cannot be in the past.");
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  const weekday = day >= 1 && day <= 5;
  const windows = weekday ? WINDOWS.filter(slot => date > today.date || slot.value > today.time) : [];
  return {
    availableSlots: windows.map(slot => slot.value), windows,
    timezone: TIME_ZONE, today: today.date, appointmentOnly: true,
    requiresConfirmation: true, operatingHours: "Monday–Friday, 9 AM–6 PM Pacific",
    message: !weekday ? "We schedule appointments Monday–Friday. Please choose a weekday."
      : windows.length ? "Choose a preferred pickup window. Dispatch must confirm your appointment."
      : "Today's pickup windows have started. Please choose another weekday.",
  };
}

function requireCourierWindow(date, start, now = new Date()) {
  const schedule = getCourierSchedule(date, now);
  const window = schedule.windows.find(slot => slot.value === start);
  if (!window) throw badRequest("That pickup window is no longer requestable. Please choose another window.");
  return window;
}

module.exports = { TIME_ZONE, WINDOWS, pacificNow, validDate, getCourierSchedule, requireCourierWindow, badRequest };
