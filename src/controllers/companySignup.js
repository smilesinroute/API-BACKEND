"use strict";

async function handleCompanySignup(req, res, pool, pathname, method, json) {

  if (pathname !== "/api/company/signup" || method !== "POST") {
    return false;
  }

  try {

    let body = "";
    for await (const chunk of req) body += chunk;

    const data = JSON.parse(body);

    const company = data.company_name;
    const email = data.email;
    const password = data.password;

    if (!company || !email || !password) {
      json(res,400,{error:"Missing fields"});
      return true;
    }

    /* create company */

    const companyResult = await pool.query(
      `INSERT INTO companies(name)
       VALUES($1)
       RETURNING id`,
      [company]
    );

    const companyId = companyResult.rows[0].id;

    /* create admin user */

    await pool.query(
      `INSERT INTO users(email,password,role,company_id)
       VALUES($1,$2,'admin',$3)`,
      [email,password,companyId]
    );

    json(res,200,{success:true});

    return true;

  } catch (err) {

    console.error("SIGNUP ERROR",err);

    json(res,500,{error:"Signup failed"});

    return true;
  }

}

module.exports = { handleCompanySignup };