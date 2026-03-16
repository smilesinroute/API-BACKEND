"use strict";

const crypto = require("crypto");

async function handleCompanySignup(req, res, pool, pathname, method, json) {

  if (pathname !== "/company/signup" || method !== "POST") {
    return false;
  }

  try {

    let body = "";

    for await (const chunk of req) {
      body += chunk;
    }

    const data = JSON.parse(body || "{}");

    const company = String(data.company_name || "").trim();
    const email = String(data.email || "").trim();
    const password = String(data.password || "").trim();

    if (!company || !email || !password) {
      json(res, 400, { error: "Missing fields" });
      return true;
    }

    /* CREATE COMPANY */

    const companyResult = await pool.query(
      `INSERT INTO companies(company_name, email)
       VALUES($1, $2)
       RETURNING id`,
      [company, email]
    );

    const companyId = companyResult.rows[0].id;

    /* CREATE ADMIN */

    const adminResult = await pool.query(
      `INSERT INTO admins (email, password, company_id)
       VALUES ($1,$2,$3)
       RETURNING id`,
      [email, password, companyId]
    );

    const adminId = adminResult.rows[0].id;

    /* CREATE SESSION TOKEN */

    const token = crypto.randomBytes(32).toString("hex");

    await pool.query(
      `INSERT INTO admin_sessions (admin_id, token)
       VALUES ($1,$2)`,
      [adminId, token]
    );

    json(res, 200, {
      success: true,
      token,
      company_id: companyId
    });

    return true;

  } catch (err) {

    console.error("SIGNUP ERROR:", err);

    json(res, 500, {
      error: "Signup failed",
      details: err.message
    });

    return true;
  }
}

module.exports = { handleCompanySignup };