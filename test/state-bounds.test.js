'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { isOutsideState } = require('../src/us-state-bounds');

test('accepts a Wisconsin plant at Wisconsin coordinates', () => {
  // Westby, WI
  assert.equal(isOutsideState(43.66, -90.86, 'WI'), false);
});

test('flags a WI plant geocoded into California', () => {
  // Nominatim mismatch: a WI town name matched a CA location
  assert.equal(isOutsideState(36.20, -119.34, 'WI'), true);
});

test('flags a Vermont plant geocoded to Texas', () => {
  assert.equal(isOutsideState(31.0, -100.0, 'VT'), true);
});

test('accepts a Texas plant in Texas', () => {
  assert.equal(isOutsideState(31.0, -100.0, 'TX'), false);
});

test('does not flag when state is unknown or coords missing', () => {
  assert.equal(isOutsideState(0, 0, ''), false);
  assert.equal(isOutsideState(null, null, 'WI'), false);
  assert.equal(isOutsideState(43.66, -90.86, 'ZZ'), false); // unknown state
});

test('border padding: a point just over the line is not flagged', () => {
  // ~0.2deg outside WI's east edge should pass thanks to the pad
  assert.equal(isOutsideState(44.0, -86.7, 'WI'), false);
});
