'use strict';
const { randomUUID } = require('node:crypto');
const { getNotarySchedule } = require('./notaryRequest');
const { getDistanceMiles } = require('./distanceMatrix');

const actFeeCents = 1000;
const travelPerMileCents = 200;
const travelMinimumCents = 2000;
const maxActs = 5000;

function error(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
function revision(value) {
  if (value === null) return null;
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw error(
      400,
      'Refresh this request before changing or sending its quote.',
    );
  }
  return value;
}
function editable(order) {
  if (order.service_type !== 'notary')
    throw error(400, 'This quote action is for Notary requests only.');
  if (
    !['pending_admin_review', 'confirmed_pending_payment'].includes(
      order.status,
    ) ||
    ![null, undefined, 'unpaid'].includes(order.payment_status) ||
    order.stripe_session_id ||
    order.paid_at ||
    order.assigned_driver_id
  ) {
    throw error(
      409,
      'This request has moved forward. Its quote can no longer be changed or sent again.',
    );
  }
}
function savedQuote(order) {
  const quote = order.pricing_breakdown;
  if (
    !quote ||
    quote.quoteRequired !== false ||
    !quote.quoteRevision ||
    !Number.isSafeInteger(quote.notaryFeeCents) ||
    quote.notaryFeeCents < 0 ||
    !Number.isSafeInteger(quote.travelFeeCents) ||
    quote.travelFeeCents < 0 ||
    quote.notaryFeeCents + quote.travelFeeCents <= 0 ||
    quote.notaryFeeCents + quote.travelFeeCents !==
      Math.round(Number(order.total_amount) * 100)
  ) {
    throw error(
      400,
      'Save a valid Notary and travel quote before sending a payment link.',
    );
  }
  revision(quote.quoteRevision);
  if (quote.notarialActs !== undefined && (
    !Number.isInteger(quote.notarialActs) ||
    quote.notarialActs < 1 ||
    quote.notarialActs > maxActs ||
    quote.notaryFeeCents !== quote.notarialActs * actFeeCents ||
    !Number.isFinite(quote.travelMiles) ||
    quote.travelMiles < 0 ||
    !Number.isSafeInteger(quote.travelPerMileCents) ||
    quote.travelPerMileCents <= 0 ||
    !Number.isSafeInteger(quote.travelMinimumCents) ||
    quote.travelMinimumCents < 0 ||
    quote.travelFeeCents !== Math.max(
      quote.travelMinimumCents,
      Math.round(quote.travelMiles * quote.travelPerMileCents),
    )
  )) throw error(400, 'Save a valid mileage quote before sending a payment link.');
  return quote;
}
async function readQuoteBody(req) {
  return new Promise((resolve, reject) => {
    let data = '',
      size = 0,
      exceeded = false;
    req.on('data', (chunk) => {
      if (exceeded) return;
      size += Buffer.byteLength(chunk);
      if (size > 4096) {
        exceeded = true;
        data = '';
        return reject(error(413, 'Quote request is too large.'));
      }
      data += chunk;
    });
    req.on('end', () => {
      if (exceeded) return;
      try {
        const body = data ? JSON.parse(data) : {};
        if (!body || typeof body !== 'object' || Array.isArray(body))
          throw new Error();
        resolve(body);
      } catch {
        reject(error(400, 'Enter valid quote details.'));
      }
    });
    req.on('error', reject);
  });
}
async function locked(pool, id, action) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    const { rows } = await client.query(
      'SELECT * FROM orders WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (!rows[0]) throw error(404, 'Order not found.');
    const result = await action(client, rows[0]);
    await client.query('COMMIT');
    return result;
  } catch (failure) {
    await client.query('ROLLBACK').catch(() => {});
    throw failure;
  } finally {
    client.release();
  }
}
function verifyQuoteRevision(order, expected) {
  editable(order);
  if ((order.pricing_breakdown?.quoteRevision ?? null) !== expected)
    throw error(409, 'The quote changed. Refresh and review the latest fees.');
}
async function saveNotaryQuote(pool, id, body, now = new Date()) {
  const notarialActs = body.notarial_acts;
  if (!Number.isInteger(notarialActs) || notarialActs < 1 || notarialActs > maxActs)
    throw error(400, 'Enter the confirmed number of notarial acts (1 to 5,000).');
  const expected = revision(body.expected_quote_revision);
  const origin = process.env.NOTARY_TRAVEL_ORIGIN?.trim();
  if (!origin) throw error(503, 'The notary travel starting point has not been configured.');
  const { rows: [snapshot] } = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
  if (!snapshot) throw error(404, 'Order not found.');
  verifyQuoteRevision(snapshot, expected);
  const address = snapshot.pickup_address?.trim();
  if (!address) throw error(400, 'A signing address is required for a mileage quote.');
  let travelMiles;
  try {
    travelMiles = await getDistanceMiles(origin, address);
  } catch {
    throw error(502, 'Could not calculate road mileage. Verify the signing address and try again.');
  }
  if (!Number.isFinite(travelMiles) || travelMiles < 0)
    throw error(502, 'The road mileage could not be verified. Try again.');
  const notaryFeeCents = notarialActs * actFeeCents;
  const travelFeeCents = Math.max(travelMinimumCents, Math.round(travelMiles * travelPerMileCents));
  const total = notaryFeeCents + travelFeeCents;
  if (total <= 0 || total > 9999999)
    throw error(
      400,
      'The total must be greater than zero and no more than 99,999.99.',
    );
  return locked(pool, id, async (client, order) => {
    verifyQuoteRevision(order, expected);
    if (order.pickup_address?.trim() !== address)
      throw error(409, 'The signing address changed. Refresh and calculate the quote again.');
    const pricing = {
      ...(order.pricing_breakdown || {}),
      quoteRequired: false,
      notaryFeeCents,
      travelFeeCents,
      notarialActs,
      travelMiles,
      travelPerMileCents,
      travelMinimumCents,
      quoteRevision: randomUUID(),
      quotedAt: now.toISOString(),
    };
    const result = await client.query(
      `UPDATE orders SET total_amount = $2, pricing_breakdown = $3
      WHERE id = $1 RETURNING id, service_type, status, payment_status, total_amount, pricing_breakdown`,
      [id, (total / 100).toFixed(2), JSON.stringify(pricing)],
    );
    return result.rows[0];
  });
}
async function approveNotaryQuote(
  pool,
  id,
  body,
  createPaymentSession,
  now = new Date(),
) {
  const expected = revision(body.expected_quote_revision);
  if (!expected) throw error(400, 'Review the saved quote before sending it.');
  return locked(pool, id, async (client, order) => {
    editable(order);
    const quote = savedQuote(order);
    if (quote.quoteRevision !== expected)
      throw error(
        409,
        'The quote changed. Refresh and review the latest fees before sending.',
      );
    if (quote.notarialActs === undefined)
      throw error(409, 'Calculate and save the notarial acts and mileage before sending this quote.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(order.customer_email || '')))
      throw error(400, 'A valid customer email is required.');
    const date =
      typeof order.scheduled_date === 'string'
        ? order.scheduled_date.slice(0, 10)
        : order.scheduled_date?.toISOString().slice(0, 10);
    const time = String(order.scheduled_time || '').slice(0, 5);
    const slot = getNotarySchedule(date, now).times.find(
      (item) => item.value === time,
    );
    if (!slot)
      throw error(
        409,
        'The requested appointment time has passed. Confirm a new time before sending a quote.',
      );
    let session;
    try {
      session = await createPaymentSession(order);
    } catch {
      throw error(
        502,
        'The payment link could not be prepared. The request remains unapproved; please retry.',
      );
    }
    if (
      !session?.id ||
      typeof session.url !== 'string' ||
      !session.url.startsWith('https://')
    )
      throw error(
        502,
        'The payment link could not be verified. No quote was sent.',
      );
    await client.query(
      `UPDATE orders SET status = 'approved_pending_payment', stripe_session_id = $2,
      stripe_checkout_url = $3 WHERE id = $1`,
      [id, session.id, session.url],
    );
    return {
      order: { ...order, scheduled_date: date, requested_time: slot },
      session,
    };
  });
}

module.exports = {
  savedQuote,
  readQuoteBody,
  saveNotaryQuote,
  approveNotaryQuote,
};
