'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PassThrough } = require('node:stream');
const { createNotaryRequest, getNotarySchedule } = require('../src/lib/notaryRequest');
const now = new Date('2026-11-06T22:00:00Z');
const address = { street: '100 Example Avenue', unit: 'Suite 2', city: 'Portland', state: 'OR', zip: '97204' };
const payload = {
  region: 'oregon', customer_name: 'Website Test', customer_email: 'TEST@example.com', customer_phone: '2025550100',
  customer_address: address, appointment_address: address,
  appointment_location: { locationType: 'business', businessName: 'Example Office', instructions: 'Check in at reception' },
  document_type: 'General document', signers: 2, documents: 3, notes: 'Please call on arrival',
  scheduled_date: '2026-11-09', scheduled_time: '10:30',
};
function fixture() {
  const writes = [];
  return { writes, async query(sql, values) {
    assert.match(sql, /INSERT INTO public.orders/); assert.match(sql, /NULL/);
    writes.push({ sql, values });
    return { rows: [{ id: '00000000-0000-4000-8000-000000000002', status: 'pending_admin_review', payment_status: 'unpaid', scheduled_date: values[6], scheduled_time: values[7] }] };
  } };
}
test('notary times fit business hours and need confirmation, with no weekend availability', () => {
  const schedule = getNotarySchedule('2026-11-09', now);
  assert.deepEqual(schedule.times.map(t => t.value), ['09:00','10:30','12:00','13:30','15:00','16:30']);
  assert.equal(schedule.requiresConfirmation, true);
  assert.equal(schedule.timezone, 'America/Los_Angeles');
  assert.equal(getNotarySchedule('2026-11-07', now).times.length, 0);
  assert.equal(getNotarySchedule('2026-11-08', now).times.length, 0);
  assert.throws(() => getNotarySchedule('2026-02-30', now), e => e.statusCode === 400);
  assert.throws(() => getNotarySchedule('2026-11-05', now), e => e.statusCode === 400);
});
test('started times are unavailable and Pacific date works at UTC midnight and DST', () => {
  assert.deepEqual(getNotarySchedule('2026-11-06', new Date('2026-11-06T23:00:00Z')).times.map(t => t.value), ['16:30']);
  assert.deepEqual(getNotarySchedule('2026-11-06', new Date('2026-11-07T00:30:00Z')).times, []);
  assert.equal(getNotarySchedule('2026-07-06', new Date('2026-07-06T15:30:00Z')).times[0].value, '09:00');
});
test('saves notary request with no trusted client price, paid status or reservation', async () => {
  const pool = fixture();
  const result = await createNotaryRequest(pool, { ...payload, service_type: 'courier', total_amount: 10, status: 'paid', payment_status: 'paid', pricing_breakdown: { total: 10 } }, now);
  assert.equal(result.total_amount, null); assert.equal(result.quote_required, true);
  assert.equal(result.status, 'pending_admin_review'); assert.equal(result.payment_status, 'unpaid');
  const { sql, values } = pool.writes[0];
  assert.match(sql, /'notary','oregon'/); assert.match(sql, /'pending_admin_review','unpaid'/);
  assert.equal(values[1], 'test@example.com'); assert.match(values[2], /Suite 2/);
  assert.equal(values[4], 2); assert.equal(values[7], '10:30');
  assert.match(values[8], /Customer phone: 2025550100/);
  assert.match(values[8], /Example Office/); assert.match(values[8], /Check in at reception/);
  assert.match(values[8], /Documents: 3/); assert.match(values[8], /QUOTE REQUIRED/);
  assert.match(values[8], /10:30 AM \(America\/Los_Angeles\)/);
  assert.deepEqual(JSON.parse(values[9]), { quoteRequired: true, documents: 3, signers: 2 });
});
for (const [name, change] of [
  ['weekend', { scheduled_date: '2026-11-07' }], ['past date', { scheduled_date: '2026-11-05' }],
  ['invalid time', { scheduled_time: '18:00' }], ['legacy display time', { scheduled_time: '10:30 AM' }],
  ['unconfigured region', { region: 'texas' }], ['outside Oregon', { appointment_address: { ...address, state: 'WA', zip: '98660' } }],
  ['missing signing address', { appointment_address: null }], ['invalid customer ZIP', { customer_address: { ...address, zip: '123' } }],
  ['missing location', { appointment_location: {} }], ['missing business', { appointment_location: { locationType: 'business' } }],
  ['missing other location', { appointment_location: { locationType: 'other' } }], ['invalid document', { document_type: 'Unlisted' }],
  ['missing other document', { document_type: 'Other', document_type_other: '' }], ['zero signers', { signers: 0 }],
  ['fractional count', { documents: 1.5 }], ['too many documents', { documents: 101 }],
  ['invalid email', { customer_email: 'invalid' }], ['invalid phone', { customer_phone: '12' }],
  ['oversized notes', { notes: 'a'.repeat(1001) }], ['non-boolean flag', { time_sensitive: 'false' }],
]) test(`rejects ${name} before writing`, async () => {
  await assert.rejects(createNotaryRequest({ query: async () => assert.fail('no database write expected') }, { ...payload, ...change }, now), e => e.statusCode === 400);
});
test('other document and location descriptions, business phone and deadline preference reach dispatch', async () => {
  const pool = fixture();
  await createNotaryRequest(pool, { ...payload, document_type: 'Other', document_type_other: 'School form', appointment_location: { locationType: 'other', description: 'Community center' }, business_phone: '2025550101', time_sensitive: true }, now);
  assert.equal(pool.writes[0].values[5], 'Other: School form');
  assert.match(pool.writes[0].values[8], /Community center/); assert.match(pool.writes[0].values[8], /2025550101/); assert.match(pool.writes[0].values[8], /Time-sensitive request/);
});
function load(file, customRequire) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), { module, require: customRequire, process, console, Buffer, setTimeout, clearTimeout });
  return module.exports;
}
const controller = load('src/controllers/notaryController.js', id => {
  if (id === 'node:url') return require('node:url');
  if (id === '../lib/notaryRequest') return require('../src/lib/notaryRequest');
  if (id === '../lib/dispatchEmails') return { sendNotaryDispatchNotification: async () => {} };
  throw new Error('Unexpected integration ' + id);
});
const { handleAPI } = load('index.js', id => {
  if (id === 'url') return require('node:url');
  if (id === './src/controllers/notaryController') return controller;
  return new Proxy({}, { get: () => async () => false });
});
async function request(url, method = 'GET', body = {}, pool = { query: async () => assert.fail('unexpected database write') }) {
  const req = new PassThrough(); Object.assign(req, { url, method, headers: { host: 'localhost' } });
  const res = { writableEnded: false, statusCode: 200, setHeader() {}, end(data) { this.body = data; this.writableEnded = true; } };
  const task = handleAPI(req, res, pool); req.end(typeof body === 'string' ? body : JSON.stringify(body)); await task;
  assert.equal(res.writableEnded, true); return { status: res.statusCode, body: JSON.parse(res.body) };
}
function futureWeekday() {
  const day = new Date(Date.now() + 7 * 86400000); while ([0,6].includes(day.getUTCDay())) day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0,10);
}
test('new public routes connect and receipt omits contact/address/private notes', async () => {
  assert.equal((await request('/api/notary/schedule?date=' + futureWeekday() + '&region=oregon')).body.times.length, 6);
  const result = await request('/api/notary/requests', 'POST', { ...payload, scheduled_date: futureWeekday() }, fixture());
  assert.equal(result.status, 201); assert.equal(result.body.quote_required, true); assert.equal(result.body.total_amount, null);
  assert.equal(result.body.customer_email, undefined); assert.equal(result.body.pickup_address, undefined); assert.equal(result.body.notes, undefined);
});
test('private reads, payment writes and old unsafe notary route stay inaccessible', async () => {
  for (const [url, method] of [['/api/notary/requests','GET'],['/api/notary/requests/id','GET'],['/api/notary/request','POST'],['/api/orders/id/status','PUT'],['/api/orders','GET']]) assert.equal((await request(url, method)).status,404);
});
test('invalid JSON, oversized bodies and unsupported regions fail without saving', async () => {
  assert.equal((await request('/api/notary/requests','POST','{')).status,400);
  assert.equal((await request('/api/notary/requests','POST',{ notes: 'a'.repeat(17000) })).status,413);
  assert.equal((await request('/api/notary/schedule?date=' + futureWeekday() + '&region=texas')).status,400);
});
test('database failure never emits a success receipt', async () => {
  const result = await request('/api/notary/requests','POST',{ ...payload, scheduled_date: futureWeekday() }, { query: async () => { throw new Error('isolated database outage'); } });
  assert.equal(result.status,500); assert.equal(result.body.id,undefined); assert.match(result.body.error,/Unable to save/);
});
test('dispatch message requests a notary quote without claiming payment or confirmed appointment', async t => {
  const previous = process.env.DISPATCH_EMAIL; process.env.DISPATCH_EMAIL = 'dispatch@example.com';
  t.after(() => { if (previous === undefined) delete process.env.DISPATCH_EMAIL; else process.env.DISPATCH_EMAIL = previous; });
  let mail;
  const emails = load('src/lib/dispatchEmails.js', id => {
    if (id === './courierSchedule') return require('../src/lib/courierSchedule');
    if (id === './mailer') return { sendMail: async value => { mail = value; } };
    throw new Error('Unexpected dependency ' + id);
  });
  await emails.sendNotaryDispatchNotification(await createNotaryRequest(fixture(), payload, now));
  assert.match(mail.subject,/mobile notary/); assert.match(mail.text,/QUOTE REQUIRED/); assert.match(mail.text,/No payment has been collected/); assert.doesNotMatch(mail.text,/\$0/);
});
test('unpriced notary request cannot enter payment checkout through existing admin approval', async () => {
  let authChecked = false;
  const admin = load('src/admin/adminRoutes.js', id => {
    if (id === './adminAuth') return { requireAdmin: () => { authChecked = true; } };
    if (id === '../lib/stripeCheckout') return { createPaymentSession: async () => assert.fail('no Stripe checkout before price is established') };
    if (id === '../lib/dispatchEmails') return { sendCustomerPaymentLink: async () => assert.fail('no payment email') };
    if (id === './adminStats') return { handleAdminStats: async () => false };
    if (id === './adminLogs') return { handleAdminLogs: async () => false };
    throw new Error('Unexpected dependency ' + id);
  });
  let response;
  const handled = await admin.handleAdminRoutes({}, {}, { query: async sql => {
    assert.match(sql, /SELECT \* FROM orders/);
    return { rows: [{ id: 'test-order', service_type: 'notary', status: 'pending_admin_review', total_amount: null, customer_email: 'test@example.com' }] };
  } }, '/admin/orders/test-order/approve', 'POST', (_res, status, body) => { response = { status, body }; });
  assert.equal(handled, true); assert.equal(authChecked, true); assert.equal(response.status, 400); assert.match(response.body.error, /Invalid order total/);
});
