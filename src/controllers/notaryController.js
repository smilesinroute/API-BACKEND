"use strict";
const { URL } = require("node:url");
const { getNotarySchedule, createNotaryRequest } = require("../lib/notaryRequest");

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "", size = 0, tooLarge = false;
    req.on("data", chunk => {
      if (tooLarge) return;
      size += Buffer.byteLength(chunk);
      if (size > 16384) {
        tooLarge = true;
        data = "";
        return reject(Object.assign(new Error("Request details are too large."), { statusCode: 413 }));
      }
      data += chunk;
    });
    req.on("end", () => {
      if (tooLarge) return;
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(Object.assign(new Error("Invalid JSON body."), { statusCode: 400 })); }
    });
    req.on("error", reject);
  });
}

async function handleNotary(req, res, pool, pathname, method, json) {
  const schedule = pathname === "/api/notary/schedule" && method === "GET";
  const request = pathname === "/api/notary/requests" && method === "POST";
  if (!schedule && !request) return false;
  try {
    if (schedule) {
      const params = new URL(req.url, "http://localhost").searchParams;
      if (params.has("region") && params.get("region") !== "oregon") {
        return json(res, 400, { error: "Online notary requests are currently available in Oregon only." });
      }
      return json(res, 200, getNotarySchedule(params.get("date")));
    }
    const order = await createNotaryRequest(pool, await readBody(req));
    if (process.env.DISPATCH_EMAIL) {
      try {
        require("../lib/dispatchEmails").sendNotaryDispatchNotification(order)
          .catch(error => console.error("[NOTARY NOTIFICATION]", error.message));
      } catch (error) { console.error("[NOTARY NOTIFICATION]", error.message); }
    }
    return json(res, 201, {
      id: order.id, service_type: "notary", status: order.status, payment_status: order.payment_status,
      scheduled_date: order.scheduled_date, scheduled_time: order.scheduled_time,
      requested_time: order.requested_time, timezone: order.timezone,
      total_amount: null, quote_required: true, requiresConfirmation: true,
    });
  } catch (error) {
    if (!error.statusCode) console.error("[NOTARY REQUEST]", error.message);
    return json(res, error.statusCode || 500, { error: error.statusCode ? error.message
      : "Unable to save your request. Please try again or contact dispatch." });
  }
}

module.exports = { handleNotary };
