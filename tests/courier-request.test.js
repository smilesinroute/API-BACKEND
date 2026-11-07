"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PassThrough } = require('node:stream');
const { createCourierRequest } = require('../src/lib/courierRequest');

const now = new Date('2026-11-06T22:00:00Z');
const payload = {
  service_type: 'courier', region: 'oregon', vehicle_type: 'sedan',
  customer_name: 'Website Test', customer_email: 'TEST@example.com', customer_phone: '2025550100',
  pickup_address: 'Public pickup test address', delivery_address: 'Public delivery test address',
  pickup_details: { locationType: 'business', businessName: 'Example Office', unit: 'Suite 2', instructions: 'Reception desk' },
  delivery_details: { locationType: 'apartment', unit: '3A', instructions: 'Call on arrival' },
  scheduled_date: '2026-11-09', scheduled_time: '12:00', delivery_deadline: '17:00',
  total_amount: 35.13, options: { fragile: false, priority: false, timeSensitive: false },
};
const pricing = { base_rate: '25.00', per_mile_rate: '2.25', fragile_fee: '10.00', priority_fee: '15.00' };
function stubGoogle(t) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
  t.after(() => { if (key === undefined) delete process.env.GOOGLE_MAPS_API_KEY; else process.env.GOOGLE_MAPS_API_KEY = key; });
  return t.mock.method(global, 'fetch', async () => ({ ok: true, json: async () => ({ status: 'OK', rows: [{ elements: [{ status: 'OK', distance: { value: 7242.03 } }] }] }) }));
}
function poolFixture() {
  const writes = [];
  return { writes, async query(sql, values) {
    if (/FROM public.pricing_config/.test(sql)) {
      assert.deepEqual(Array.from(values), ['oregon', 'courier', 'standard']);
      return { rows: [pricing] };
    }
    assert.match(sql, /INSERT INTO public.orders/);
    writes.push({ sql, values });
    return { rows: [{ id: '00000000-0000-4000-8000-000000000001', status: 'pending_admin_review', payment_status: 'unpaid', scheduled_date: values[8], scheduled_time: values[9], total_amount: values[10] }] };
  } };
}

test('saves location/contact/window details and server-calculated pricing for dispatch review', async t => {
  stubGoogle(t);
  const pool = poolFixture();
  const result = await createCourierRequest(pool, { ...payload, distance_miles: 999, pricing_breakdown: { baseFee: 0 } }, now);
  assert.equal(result.status, 'pending_admin_review');
  assert.equal(result.payment_status, 'unpaid');
  assert.equal(result.requested_window.end, '15:00');
  const values = pool.writes[0].values;
  assert.equal(values[3], 'test@example.com');
  assert.equal(values[6], 4.5);
  assert.equal(values[10], 35.13);
  assert.match(values[11], /Example Office/);
  assert.match(values[11], /Apartment \/ condo/);
  assert.match(values[11], /Suite 2/);
  assert.match(values[11], /2025550100/);
  assert.match(values[11], /12–3 PM \(America\/Los_Angeles\)/);
  assert.match(values[11], /17:00/);
  assert.equal(JSON.parse(values[12]).baseFee, 25);
});

test('altered client price cannot create a request', async t => {
  stubGoogle(t);
  const pool = poolFixture();
  await assert.rejects(createCourierRequest(pool, { ...payload, total_amount: 1 }, now), e => e.statusCode === 409);
  assert.equal(pool.writes.length, 0);
});

for (const [label, change] of [
  ['weekend', { scheduled_date: '2026-11-07' }],
  ['past date', { scheduled_date: '2026-11-05' }],
  ['outside business hours', { scheduled_time: '18:00' }],
  ['business without name', { pickup_details: { locationType: 'business' } }],
  ['other without description', { delivery_details: { locationType: 'other' } }],
  ['missing location type', { delivery_details: {} }],
  ['invalid phone', { customer_phone: '12' }],
  ['invalid email', { customer_email: 'no-email' }],
  ['deadline before pickup', { delivery_deadline: '10:00' }],
  ['deadline after closing', { delivery_deadline: '19:00' }],
  ['unconfigured region', { region: 'texas' }],
  ['invalid options', { options: { priority: 'false' } }],
]) test(`rejects ${label} before database or network work`, async () => {
  await assert.rejects(createCourierRequest({ query: async () => assert.fail('no database work expected') }, { ...payload, ...change }, now), e => e.statusCode === 400);
});

test('option object cannot override trusted region/service/addresses', async t => {
  stubGoogle(t);
  const pool = poolFixture();
  await createCourierRequest(pool, { ...payload, options: { region: 'global', serviceType: 'notary', pickupAddress: 'fake' } }, now);
  assert.equal(pool.writes[0].values[1], 'oregon');
});

// Exercise the real router, orders controller, quote and scheduling code while
// isolating unrelated integrations. No production database or emails are used.
function loadModule(file, customRequire) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), { module, require: customRequire, process, console, Buffer });
  return module.exports;
}
const orders = loadModule('src/controllers/ordersController.js', id => {
  if (id === '../lib/courierRequest') return require('../src/lib/courierRequest');
  if (id === '../lib/dispatchEmails') return { sendDispatchNotification: async () => {} };
  throw new Error('Unexpected dependency ' + id);
});
const { handleAPI } = loadModule('index.js', id => {
  if (id === 'url') return require('node:url');
  if (id === './src/controllers/ordersController') return orders;
  if (id === './src/controllers/availabilityController') return require('../src/controllers/availabilityController');
  if (id === './src/routes/quote') return require('../src/routes/quote');
  return new Proxy({}, { get: () => async () => false });
});
async function request(url, method = 'GET', body = {}, pool = { query: async () => assert.fail('unexpected database access') }) {
  const req = new PassThrough();
  Object.assign(req, { url, method, headers: { host: 'localhost', origin: 'https://smilesinroute.delivery' } });
  const res = { writableEnded: false, statusCode: 200, setHeader() {}, end(value = '') { this.body = value; this.writableEnded = true; } };
  const task = handleAPI(req, res, pool);
  req.end(JSON.stringify(body));
  await task;
  assert.equal(res.writableEnded, true);
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

test('schedule route is connected and returns appointment-request policy', async () => {
  const result = await request('/api/schedule?date=2099-01-05&region=oregon');
  assert.equal(result.status, 200);
  assert.equal(result.body.appointmentOnly, true);
  assert.equal(result.body.windows.length, 3);
});

test('public order reads, status changes and manual payment remain inaccessible', async () => {
  for (const [url, method] of [['/api/orders', 'GET'], ['/api/orders/known-id', 'GET'], ['/api/orders/known-id/status', 'PUT'], ['/api/orders/known-id/manual-pay', 'POST']]) {
    assert.equal((await request(url, method)).status, 404);
  }
});

test('public POST saves one request and returns a safe pending receipt', async t => {
  stubGoogle(t);
  const pool = poolFixture();
  const response = await request('/api/orders', 'POST', { ...payload, scheduled_date: '2099-01-05' }, pool);
  assert.equal(response.status, 201);
  assert.equal(response.body.requiresConfirmation, true);
  assert.equal(response.body.total_amount, 35.13);
  assert.equal(response.body.customer_email, undefined);
  assert.equal(response.body.notes, undefined);
  assert.equal(pool.writes.length, 1);
});

test('oversized requests fail without reaching the database', async () => {
  const result = await request('/api/orders', 'POST', { notes: 'x'.repeat(17000) });
  assert.equal(result.status, 413);
});

test('dispatch and payment messages describe a pickup window, not an exact-time promise', async t => {
  const sent = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/lib/dispatchEmails.js'), 'utf8'), {
    module, process, setTimeout, clearTimeout,
    require(id) {
      if (id === './mailer') return { sendMail: async mail => { sent.push(mail); } };
      if (id === './courierSchedule') return require('../src/lib/courierSchedule');
      throw new Error('Unexpected email dependency ' + id);
    },
  });
  const previous = process.env.DISPATCH_EMAIL;
  process.env.DISPATCH_EMAIL = 'dispatch@example.invalid';
  t.after(() => { if (previous === undefined) delete process.env.DISPATCH_EMAIL; else process.env.DISPATCH_EMAIL = previous; });
  const order = { id: 'test-reference', service_type: 'courier', scheduled_date: '2026-11-09', scheduled_time: '09:00:00', total_amount: '35.13', notes: 'Pickup type: Business\nPickup business: Example Office', pickup_address: 'Public pickup', delivery_address: 'Public delivery' };
  await module.exports.sendDispatchNotification(order);
  await module.exports.sendCustomerPaymentLink({ to: 'customer@example.invalid', paymentLink: 'https://example.invalid/test-checkout', order });
  assert.match(sent[0].text, /9 AM–12 PM/);
  assert.match(sent[0].text, /Example Office/);
  assert.match(sent[0].text, /America\/Los_Angeles/);
  assert.match(sent[1].text, /Approved pickup window/);
  assert.match(sent[1].text, /9 AM–12 PM/);
});
