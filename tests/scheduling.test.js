"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { getCourierSchedule, requireCourierWindow, pacificNow } = require('../src/lib/courierSchedule');

test('weekday requests offer exactly the approved 9–6 Pacific windows', () => {
  const result = getCourierSchedule('2026-11-09', new Date('2026-11-06T22:00:00Z'));
  assert.deepEqual(result.availableSlots, ['09:00', '12:00', '15:00']);
  assert.equal(result.windows[2].end, '18:00');
  assert.equal(result.timezone, 'America/Los_Angeles');
  assert.equal(result.requiresConfirmation, true);
  assert.equal(result.appointmentOnly, true);
});

test('weekends are closed and malformed/nonexistent dates are rejected', () => {
  const now = new Date('2026-11-06T22:00:00Z');
  for (const date of ['2026-11-07', '2026-11-08']) assert.equal(getCourierSchedule(date, now).windows.length, 0);
  for (const date of ['', null, '2026-02-30', '2026-13-01', '2026-11-09anything']) {
    assert.throws(() => getCourierSchedule(date, now), e => e.statusCode === 400);
  }
});

test('same-day requests exclude started windows and close after the final window starts', () => {
  assert.deepEqual(getCourierSchedule('2026-11-06', new Date('2026-11-06T16:59:00Z')).availableSlots, ['09:00', '12:00', '15:00']);
  assert.deepEqual(getCourierSchedule('2026-11-06', new Date('2026-11-06T17:00:00Z')).availableSlots, ['12:00', '15:00']);
  assert.deepEqual(getCourierSchedule('2026-11-06', new Date('2026-11-06T20:00:00Z')).availableSlots, ['15:00']);
  assert.equal(getCourierSchedule('2026-11-06', new Date('2026-11-06T23:00:00Z')).windows.length, 0);
  assert.throws(() => requireCourierWindow('2026-11-06', '09:00', new Date('2026-11-06T18:00:00Z')));
});

test('Pacific calendar day remains correct around UTC midnight and daylight saving', () => {
  assert.equal(pacificNow(new Date('2026-11-07T01:00:00Z')).date, '2026-11-06');
  assert.equal(pacificNow(new Date('2026-07-06T16:00:00Z')).time, '09:00');
  assert.equal(pacificNow(new Date('2026-11-06T17:00:00Z')).time, '09:00');
  assert.throws(() => getCourierSchedule('2026-11-05', new Date('2026-11-07T01:00:00Z')), e => e.statusCode === 400);
});
