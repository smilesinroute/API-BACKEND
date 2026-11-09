'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PassThrough } = require('node:stream');
const {
  saveNotaryQuote,
  approveNotaryQuote,
} = require('../src/lib/notaryQuote');
const { createPool, ID, REV, quoted } = require('./helpers/notaryQuoteFixture');
const now = new Date('2026-11-06T22:00:00Z');
const fees = {
  notarial_acts: 2,
  expected_quote_revision: null,
};
const session = {
  id: 'cs_isolated_test',
  url: 'https://example.com/isolated-checkout',
};
const quotedPool = (extra) =>
  createPool({ total_amount: '44.00', pricing_breakdown: quoted, ...extra });
const travelOrigin = '200 Sample Boulevard, Portland, OR 97201';
const defaultFetch = global.fetch;
const originalOrigin = process.env.NOTARY_TRAVEL_ORIGIN;
const originalKey = process.env.GOOGLE_MAPS_API_KEY;
const distance = miles => ({
  ok: true,
  json: async () => ({
    status: 'OK',
    rows: [{ elements: [{ status: 'OK', distance: { value: miles * 1609.34 } }] }],
  }),
});
test.before(() => {
  process.env.NOTARY_TRAVEL_ORIGIN = travelOrigin;
  process.env.GOOGLE_MAPS_API_KEY = 'isolated-distance-key';
  global.fetch = async (url) => {
    const route = new URL(url);
    assert.equal(route.searchParams.get('origins'), travelOrigin);
    assert.equal(route.searchParams.get('destinations'), '100 Example Avenue, Portland, OR 97204');
    return distance(12);
  };
});
test.after(() => {
  global.fetch = defaultFetch;
  if (originalOrigin === undefined) delete process.env.NOTARY_TRAVEL_ORIGIN;
  else process.env.NOTARY_TRAVEL_ORIGIN = originalOrigin;
  if (originalKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
  else process.env.GOOGLE_MAPS_API_KEY = originalKey;
});
test('saving a quote keeps request unpaid/pending and calculates amount from cents', async () => {
  const pool = createPool();
  const result = await saveNotaryQuote(
    pool,
    ID,
    {
      ...fees,
      notary_fee: '0.01',
      travel_fee: '0.01',
      total_amount: 1,
      status: 'paid',
    },
    now,
  );
  assert.equal(result.total_amount, '44.00');
  assert.equal(result.status, 'pending_admin_review');
  assert.equal(result.payment_status, 'unpaid');
  assert.equal(result.pricing_breakdown.notaryFeeCents, 2000);
  assert.equal(result.pricing_breakdown.travelFeeCents, 2400);
  assert.equal(result.pricing_breakdown.travelMiles, 12);
  assert.equal(result.pricing_breakdown.notarialActs, 2);
  assert.equal(JSON.stringify(result).includes(travelOrigin), false);
  assert.equal(result.pricing_breakdown.quoteRequired, false);
  assert.equal(result.pricing_breakdown.documents, 2);
  assert.match(result.pricing_breakdown.quoteRevision, /^[a-f0-9-]{36}$/);
  assert.ok(pool.events.includes('COMMIT'));
  assert.equal(pool.events.at(-1), 'release');
});
test('invalid act counts and missing quote revision cannot be saved', async () => {
  for (const input of [
    { ...fees, notarial_acts: 0 },
    { ...fees, notarial_acts: 1.5 },
    { ...fees, notarial_acts: '2' },
    { ...fees, notarial_acts: 5001 },
    { notarial_acts: 2 },
  ]) {
    const pool = createPool();
    await assert.rejects(saveNotaryQuote(pool, ID, input), { statusCode: 400 });
    assert.equal(pool.events.length, 0);
  }
});
test('short travel uses the minimum and an unavailable route leaves the quote unsaved', async (t) => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  global.fetch = async () => distance(4.25);
  const short = await saveNotaryQuote(createPool(), ID, fees);
  assert.equal(short.pricing_breakdown.travelMiles, 4.25);
  assert.equal(short.pricing_breakdown.travelFeeCents, 2000);
  assert.equal(short.total_amount, '40.00');
  global.fetch = async () => { throw new Error('offline'); };
  const pool = createPool();
  await assert.rejects(saveNotaryQuote(pool, ID, fees), { statusCode: 502 });
  assert.equal(pool.state.total_amount, null);
});
test('missing mileage origin leaves the quote unsaved', async (t) => {
  t.after(() => { process.env.NOTARY_TRAVEL_ORIGIN = travelOrigin; });
  delete process.env.NOTARY_TRAVEL_ORIGIN;
  const pool = createPool();
  await assert.rejects(saveNotaryQuote(pool, ID, fees), { statusCode: 503 });
  assert.equal(pool.events.length, 0);
});
test('a signing address that changes while mileage is calculated cannot be quoted', async (t) => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  const pool = createPool();
  global.fetch = async () => {
    pool.state = { ...pool.state, pickup_address: '300 Different Avenue' };
    return distance(12);
  };
  await assert.rejects(saveNotaryQuote(pool, ID, fees), { statusCode: 409 });
  assert.equal(pool.state.total_amount, null);
});
test('an older unsent quote must be recalculated before approval', async () => {
  const { notarialActs, travelMiles, travelPerMileCents, travelMinimumCents, ...legacy } = quoted;
  const pool = quotedPool({ pricing_breakdown: legacy });
  await assert.rejects(
    approveNotaryQuote(pool, ID, { expected_quote_revision: REV }, async () => assert.fail('no checkout expected'), now),
    { statusCode: 409 },
  );
  const saved = await saveNotaryQuote(pool, ID, { ...fees, expected_quote_revision: REV }, now);
  assert.equal(saved.pricing_breakdown.notarialActs, 2);
  assert.equal(saved.total_amount, '44.00');
});
for (const [label, change] of [
  ['paid', { payment_status: 'paid' }],
  ['approved', { status: 'approved_pending_payment' }],
  ['assigned', { assigned_driver_id: 'driver-1' }],
  ['existing checkout', { stripe_session_id: 'old' }],
  ['courier', { service_type: 'courier' }],
])
  test(`cannot edit ${label} request`, async () => {
    const pool = createPool(change);
    await assert.rejects(saveNotaryQuote(pool, ID, fees), (e) =>
      [400, 409].includes(e.statusCode),
    );
    assert.equal(pool.events.some((sql) => /UPDATE orders/.test(sql)), false);
    assert.equal(pool.state.total_amount, null);
  });
test('stale revision cannot overwrite fees; current revision can update them', async () => {
  const pool = createPool();
  await saveNotaryQuote(pool, ID, fees, now);
  await assert.rejects(
    saveNotaryQuote(pool, ID, { ...fees, notarial_acts: 4 }),
    (e) => e.statusCode === 409,
  );
  assert.equal(pool.state.total_amount, '44.00');
  await saveNotaryQuote(
    pool,
    ID,
    {
      ...fees,
      notarial_acts: 3,
      expected_quote_revision: pool.state.pricing_breakdown.quoteRevision,
    },
    now,
  );
  assert.equal(pool.state.total_amount, '54.00');
});
test('two simultaneous saves cannot overwrite each other from the same revision', async () => {
  const pool = createPool();
  const results = await Promise.allSettled([
    saveNotaryQuote(pool, ID, fees),
    saveNotaryQuote(pool, ID, { ...fees, notarial_acts: 3 }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
  assert.ok(['44.00', '54.00'].includes(pool.state.total_amount));
});
test('quote approval uses saved fees and moves to awaiting payment without marking paid', async () => {
  const pool = quotedPool();
  let calls = 0;
  await approveNotaryQuote(
    pool,
    ID,
    { expected_quote_revision: REV, total_amount: 1 },
    async (order) => {
      calls++;
      assert.equal(order.total_amount, '44.00');
      return session;
    },
    now,
  );
  assert.equal(calls, 1);
  assert.equal(pool.state.status, 'approved_pending_payment');
  assert.equal(pool.state.payment_status, 'unpaid');
  assert.equal(pool.state.stripe_session_id, session.id);
});
test('duplicate concurrent approvals prepare one checkout only', async () => {
  const pool = quotedPool();
  let calls = 0;
  const create = async () => {
    calls++;
    await Promise.resolve();
    return session;
  };
  const results = await Promise.allSettled([
    approveNotaryQuote(pool, ID, { expected_quote_revision: REV }, create, now),
    approveNotaryQuote(pool, ID, { expected_quote_revision: REV }, create, now),
  ]);
  assert.equal(calls, 1);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(pool.state.status, 'approved_pending_payment');
});
for (const [label, change, body] of [
  [
    'no saved quote',
    { pricing_breakdown: { quoteRequired: true }, total_amount: null },
    { expected_quote_revision: REV },
  ],
  [
    'stale quote',
    {},
    { expected_quote_revision: '20000000-0000-4000-8000-000000000099' },
  ],
  ['missing revision', {}, {}],
  [
    'mismatched total',
    { total_amount: '1.00' },
    { expected_quote_revision: REV },
  ],
  ['missing email', { customer_email: '' }, { expected_quote_revision: REV }],
  [
    'past appointment',
    { scheduled_date: '2026-11-05' },
    { expected_quote_revision: REV },
  ],
])
  test(`cannot send ${label}`, async () => {
    await assert.rejects(
      approveNotaryQuote(
        quotedPool(change),
        ID,
        body,
        async () => assert.fail('no checkout expected'),
        now,
      ),
      (e) => [400, 409].includes(e.statusCode),
    );
  });
test('Stripe and database failures roll back without approving the request', async () => {
  const pool = quotedPool();
  await assert.rejects(
    approveNotaryQuote(
      pool,
      ID,
      { expected_quote_revision: REV },
      async () => {
        throw new Error('isolated Stripe failure');
      },
      now,
    ),
    (e) => e.statusCode === 502,
  );
  assert.equal(pool.state.status, 'pending_admin_review');
  pool.failUpdate = true;
  await assert.rejects(
    approveNotaryQuote(
      pool,
      ID,
      { expected_quote_revision: REV },
      async () => session,
      now,
    ),
  );
  assert.equal(pool.state.status, 'pending_admin_review');
  assert.equal(pool.state.stripe_session_id, undefined);
});
function load(file, hook) {
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '..', file), 'utf8'),
    {
      module,
      require: hook,
      process,
      console,
      Buffer,
      setTimeout,
      clearTimeout,
    },
  );
  return module.exports;
}
function routerFixture(pool, mailFails = false) {
  let sent = 0,
    created = 0;
  const routes = load('src/admin/adminRoutes.js', (id) => {
    if (id === './adminAuth') return require('../src/admin/adminAuth');
    if (id === './dispatchOrders') return { assignCourierOrder: async () => assert.fail('no dispatch expected') };
    if (id === '../lib/notaryQuote') return require('../src/lib/notaryQuote');
    if (id === '../lib/dispatchEmails')
      return {
        sendCustomerPaymentLink: async () => {
          sent++;
          if (mailFails) throw new Error('isolated mail timeout');
        },
      };
    if (id === '../lib/stripeCheckout')
      return {
        createPaymentSession: async () => {
          created++;
          return session;
        },
      };
    if (id === './adminStats') return { handleAdminStats: async () => false };
    if (id === './adminLogs') return { handleAdminLogs: async () => false };
    throw new Error('Unexpected dependency ' + id);
  });
  return {
    get sent() {
      return sent;
    },
    get created() {
      return created;
    },
    async request(action, body, token = 'isolated-admin-test') {
      const req = new PassThrough();
      req.headers = token ? { authorization: 'Bearer ' + token } : {};
      let output;
      const task = routes.handleAdminRoutes(
        req,
        {},
        pool,
        `/admin/orders/${ID}/${action}`,
        'POST',
        (_res, status, data) => {
          output = { status, data };
        },
      );
      req.end(typeof body === 'string' ? body : JSON.stringify(body));
      await task;
      return output;
    },
  };
}
test('real auth guard rejects missing/incorrect credentials before any read/write', async (t) => {
  const old = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = 'isolated-admin-test';
  t.after(() => {
    if (old === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = old;
  });
  const pool = createPool();
  const api = routerFixture(pool);
  assert.equal((await api.request('notary-quote', fees, '')).status, 401);
  assert.equal((await api.request('notary-quote', fees, 'wrong')).status, 403);
  assert.equal(pool.events.length, 0);
});
test('authenticated save sends nothing, approval uses existing email flow, duplicate send is rejected', async (t) => {
  const old = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = 'isolated-admin-test';
  t.after(() => {
    if (old === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = old;
  });
  const pool = createPool();
  const api = routerFixture(pool);
  const saved = await api.request('notary-quote', fees);
  assert.equal(saved.status, 200);
  assert.equal(api.sent, 0);
  assert.equal(api.created, 0);
  const revision = saved.data.order.pricing_breakdown.quoteRevision;
  const approved = await api.request('approve', {
    expected_quote_revision: revision,
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.data.email_sent, true);
  assert.equal(api.sent, 1);
  assert.equal(api.created, 1);
  assert.equal(
    (await api.request('approve', { expected_quote_revision: revision }))
      .status,
    409,
  );
  assert.equal(api.sent, 1);
  assert.equal((await api.request('reject', {})).status, 409);
  assert.equal(pool.state.status, 'approved_pending_payment');
});
test('mail failure preserves approval and returns saved payment-link recovery', async (t) => {
  const old = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = 'isolated-admin-test';
  t.after(() => {
    if (old === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = old;
  });
  const pool = quotedPool();
  const api = routerFixture(pool, true);
  const result = await api.request('approve', { expected_quote_revision: REV });
  assert.equal(result.status, 200);
  assert.equal(result.data.email_sent, false);
  assert.equal(result.data.payment_url, session.url);
  assert.equal(pool.state.status, 'approved_pending_payment');
});
test('malformed JSON and oversized requests are rejected without a quote update', async (t) => {
  const old = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = 'isolated-admin-test';
  t.after(() => {
    if (old === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = old;
  });
  const pool = createPool();
  const api = routerFixture(pool);
  assert.equal((await api.request('notary-quote', '{')).status, 400);
  assert.equal(
    (await api.request('notary-quote', { notes: 'a'.repeat(5000) })).status,
    413,
  );
  assert.equal(pool.state.total_amount, null);
});
test('Notary checkout has separate fees and a stable revision-based idempotency key; Courier keeps its existing checkout', async (t) => {
  const oldSuccess = process.env.STRIPE_SUCCESS_URL,
    oldCancel = process.env.STRIPE_CANCEL_URL;
  process.env.STRIPE_SUCCESS_URL = 'https://example.com/success';
  process.env.STRIPE_CANCEL_URL = 'https://example.com/cancel';
  t.after(() => {
    if (oldSuccess === undefined) delete process.env.STRIPE_SUCCESS_URL;
    else process.env.STRIPE_SUCCESS_URL = oldSuccess;
    if (oldCancel === undefined) delete process.env.STRIPE_CANCEL_URL;
    else process.env.STRIPE_CANCEL_URL = oldCancel;
  });
  const calls = [];
  function Stripe() {
    this.checkout = {
      sessions: {
        create: async (params, options) => {
          calls.push({ params, options });
          return session;
        },
      },
    };
  }
  const checkout = load('src/lib/stripeCheckout.js', (id) => {
    if (id === 'stripe') return Stripe;
    if (id === './notaryQuote') return require('../src/lib/notaryQuote');
    throw new Error(id);
  });
  await checkout.createPaymentSession(quotedPool().state);
  assert.deepEqual(
    Array.from(
      calls[0].params.line_items,
      (item) => item.price_data.unit_amount,
    ),
    [1000, 2400],
  );
  assert.match(
    calls[0].params.line_items[0].price_data.product_data.name,
    /notary/i,
  );
  assert.equal(calls[0].params.line_items[0].quantity, 2);
  assert.match(calls[0].params.line_items[1].price_data.product_data.name, /12 one-way road miles/);
  assert.match(calls[0].params.custom_text.submit.message, /agree to the separate \$24.00 travel fee/);
  assert.equal(calls[0].options.idempotencyKey, `notary:${ID}:${REV}`);
  assert.equal(calls[0].params.metadata.order_id, ID);
  await checkout.createPaymentSession({
    ...quotedPool().state,
    service_type: 'courier',
  });
  assert.equal(calls[1].params.line_items.length, 1);
  assert.equal(calls[1].params.custom_text, undefined);
  assert.equal(calls[1].options, undefined);
  assert.match(
    calls[1].params.line_items[0].price_data.product_data.name,
    /Courier/,
  );
});
test('customer Notary email lists both fees and does not use Courier pickup/delivery wording', async () => {
  let mail;
  const emails = load('src/lib/dispatchEmails.js', (id) => {
    if (id === './mailer')
      return {
        sendMail: async (value) => {
          mail = value;
        },
      };
    if (id === './courierSchedule')
      return require('../src/lib/courierSchedule');
    if (id === './notaryQuote') return require('../src/lib/notaryQuote');
    throw new Error(id);
  });
  await emails.sendCustomerPaymentLink({
    to: 'customer@example.com',
    paymentLink: session.url,
    order: { ...quotedPool().state, requested_time: { label: '10:30 AM' } },
  });
  assert.match(mail.subject, /notary quote/);
  assert.match(mail.text, /Notary fees \(2 at \$10.00 per act\): \$20.00/);
  assert.match(mail.text, /Travel fee \(12 one-way road miles.*\): \$24.00/);
  assert.match(mail.text, /Total: \$44.00/);
  assert.match(mail.text, /agree to the quoted travel fee/);
  assert.equal(mail.text.includes(travelOrigin), false);
  assert.doesNotMatch(mail.text, /Courier Delivery|assign your driver/);
});
