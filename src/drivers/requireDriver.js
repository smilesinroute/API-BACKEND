'use strict';

module.exports = async function requireDriver(req, res, pool) {
  const email =
    req.headers['cf-access-authenticated-user-email'];

  if (!email) {
    return null;
  }

  const { rows } = await pool.query(
    'SELECT * FROM drivers WHERE email = ',
    [email.toLowerCase()]
  );

  if (!rows.length) {
    return null;
  }

  return rows[0];
};
