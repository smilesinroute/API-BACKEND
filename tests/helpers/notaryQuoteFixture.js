'use strict';
const clone = (value) => JSON.parse(JSON.stringify(value));
const ID = '10000000-0000-4000-8000-000000000001';
const REV = '20000000-0000-4000-8000-000000000001';
function createPool(seed = {}) {
  let state = {
    id: ID,
    service_type: 'notary',
    status: 'pending_admin_review',
    payment_status: 'unpaid',
    total_amount: null,
    pricing_breakdown: { quoteRequired: true, documents: 2, signers: 1 },
    customer_name: 'Preview Customer',
    customer_email: 'customer@example.com',
    pickup_address: '100 Example Avenue, Portland, OR 97204',
    scheduled_date: '2030-11-11',
    scheduled_time: '10:30:00',
    signers: 1,
    document_type: 'General document',
    ...clone(seed),
  };
  let tail = Promise.resolve();
  const events = [];
  const pool = {
    events,
    get state() {
      return clone(state);
    },
    set state(value) {
      state = clone(value);
    },
    failUpdate: false,
    async query(sql) {
      events.push(sql);
      if (/SELECT \* FROM orders/.test(sql))
        return { rows: [clone(state)], rowCount: 1 };
      if (sql.startsWith("UPDATE orders SET status = 'rejected'")) {
        await tail;
        const pending = [
          'pending_admin_review',
          'confirmed_pending_payment',
        ].includes(state.status);
        const unpaid =
          state.payment_status == null || state.payment_status === 'unpaid';
        if (
          state.service_type === 'notary' &&
          (!pending ||
            !unpaid ||
            state.stripe_session_id ||
            state.paid_at ||
            state.assigned_driver_id)
        ) {
          return { rowCount: 0 };
        }
        state.status = 'rejected';
        return { rowCount: 1 };
      }
      throw new Error('Unexpected pool query: ' + sql);
    },
    async connect() {
      let unlock,
        snapshot,
        dirty = false;
      return {
        async query(sql, values) {
          events.push(sql);
          if (sql === 'BEGIN' || sql.startsWith('SET LOCAL'))
            return { rows: [] };
          if (/SELECT \* FROM orders.*FOR UPDATE/.test(sql)) {
            const previous = tail;
            tail = new Promise((resolve) => {
              unlock = resolve;
            });
            await previous;
            snapshot = clone(state);
            return { rows: [clone(state)], rowCount: 1 };
          }
          if (sql === 'COMMIT' || sql === 'ROLLBACK') {
            if (sql === 'ROLLBACK' && dirty) state = snapshot;
            if (unlock) {
              unlock();
              unlock = undefined;
            }
            return { rows: [] };
          }
          if (/UPDATE orders SET total_amount/.test(sql)) {
            if (pool.failUpdate)
              throw new Error('isolated database write failure');
            state.total_amount = values[1];
            state.pricing_breakdown = JSON.parse(values[2]);
            dirty = true;
            return { rows: [clone(state)], rowCount: 1 };
          }
          if (
            /UPDATE orders SET status = 'approved_pending_payment'/.test(sql)
          ) {
            if (pool.failUpdate)
              throw new Error('isolated approval write failure');
            Object.assign(state, {
              status: 'approved_pending_payment',
              stripe_session_id: values[1],
              stripe_checkout_url: values[2],
            });
            dirty = true;
            return { rows: [clone(state)], rowCount: 1 };
          }
          throw new Error('Unexpected client query: ' + sql);
        },
        release() {
          events.push('release');
          if (unlock) {
            unlock();
            unlock = undefined;
          }
        },
      };
    },
  };
  return pool;
}
const quoted = {
  quoteRequired: false,
  notaryFeeCents: 2000,
  travelFeeCents: 2400,
  notarialActs: 2,
  travelMiles: 12,
  travelPerMileCents: 200,
  travelMinimumCents: 2000,
  quoteRevision: REV,
  documents: 2,
  signers: 1,
};
module.exports = { createPool, ID, REV, quoted };
