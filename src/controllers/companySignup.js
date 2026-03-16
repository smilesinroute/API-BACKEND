"use strict";

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

    const company = String(data.company || "").trim();
    const email = String(data.email || "").trim();
    const password = String(data.password || "").trim();

    if (!company || !email || !password) {
      json(res, 400, { error: "Missing fields" });
      return true;
    }

    /* CREATE COMPANY */

    const companyResult = await pool.query(
      `INSERT INTO companies (name)
       VALUES ($1)
       RETURNING id`,
      [company]
    );

    const companyId = companyResult.rows[0].id;

    /* CREATE ADMIN USER */

    await pool.query(
      `INSERT INTO admins (email, password, company_id)
       VALUES ($1,$2,$3)`,
      [email, password, companyId]
    );

    json(res, 200, {
      success: true,
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