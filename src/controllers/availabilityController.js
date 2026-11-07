"use strict";

const { URL } = require("node:url");
const { getCourierSchedule } = require("../lib/courierSchedule");

async function handleAvailability(req, res, pool, pathname, method, json) {
  if (method !== "GET" || !["/api/schedule", "/api/v1/availability"].includes(pathname)) return false;
  try {
    const query = new URL(req.url, "http://localhost").searchParams;
    if (query.has("region") && query.get("region") !== "oregon") {
      return json(res, 400, { error: "Online appointment requests are currently available for Oregon only." });
    }
    return json(res, 200, getCourierSchedule(query.get("date")));
  } catch (error) {
    return json(res, error.statusCode || 500, { error: error.statusCode ? error.message : "Unable to load pickup windows." });
  }
}

module.exports = { handleAvailability };
