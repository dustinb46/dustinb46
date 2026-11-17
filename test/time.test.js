'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseTs, hoursSince, agoLabel } = require('../src/time');

const NOW = Date.parse('2026-11-17T12:00:00Z');

test('parseTs accepts SQLite datetime (UTC, no zone)', () => {
  assert.equal(parseTs('2026-11-17 06:00:00').toISOString(), '2026-11-17T06:00:00.000Z');
});

test('parseTs accepts ISO strings that already carry a zone', () => {
  // This is the shape that produced "NaNd ago": appending Z to it broke the date.
  assert.equal(parseTs('2026-07-13T15:30:55.485Z').toISOString(), '2026-07-13T15:30:55.485Z');
  assert.equal(parseTs('2026-07-13T10:30:55-05:00').toISOString(), '2026-07-13T15:30:55.000Z');
});

test('parseTs treats a zoneless ISO timestamp as UTC', () => {
  assert.equal(parseTs('2026-07-13T15:30:55').toISOString(), '2026-07-13T15:30:55.000Z');
});

test('parseTs returns null for junk instead of an invalid date', () => {
  assert.equal(parseTs('not a date'), null);
  assert.equal(parseTs(''), null);
  assert.equal(parseTs(null), null);
});

test('hoursSince and agoLabel never produce NaN', () => {
  assert.equal(hoursSince('2026-11-17T06:00:00.000Z', NOW), 6);
  assert.equal(agoLabel('2026-11-17T11:30:00.000Z', NOW), 'just now');
  assert.equal(agoLabel('2026-11-17 06:00:00', NOW), '6h ago');
  assert.equal(agoLabel('2026-07-13T15:30:55.485Z', NOW), '126d ago');
  assert.equal(agoLabel('garbage', NOW), null);
});
