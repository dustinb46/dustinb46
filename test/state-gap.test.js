'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { normCode, pickPlantCode, categoryFromHint } = require('../scripts/ingest-state-gap');

test('normCode strips zero padding so 19-0150 matches 19-150', () => {
  assert.equal(normCode('19-0150'), normCode('19-150'));
  assert.equal(normCode('27-341'), '27-341');
  assert.equal(normCode('not-a-code'), null);
});

test('pickPlantCode preserves FIPS-prefixed codes for IA/MN', () => {
  assert.equal(pickPlantCode({ State: 'IA', 'Plant Code / License ID': '19-0150' }), '19-0150');
  assert.equal(pickPlantCode({ State: 'MN', 'Plant Code / License ID': '27-341' }), '27-341');
});

test('pickPlantCode namespaces PA license numbers', () => {
  assert.equal(pickPlantCode({ State: 'PA', 'Plant Code / License ID': '10002193' }), 'PA-LIC-10002193');
});

test('pickPlantCode returns null when code is missing', () => {
  assert.equal(pickPlantCode({ State: 'PA', 'Plant Code / License ID': '' }), null);
});

test('categoryFromHint picks the right bucket', () => {
  assert.equal(categoryFromHint({ 'Product Hint': 'Cheese' }), 'cheese');
  assert.equal(categoryFromHint({ 'License / Permit Type': 'Ice Cream Mfg' }), 'frozen dessert');
  assert.equal(categoryFromHint({ 'Product Hint': 'Yogurt' }), 'cultured');
  assert.equal(categoryFromHint({ 'Product Hint': 'Whey processing' }), 'dry/whey');
  assert.equal(categoryFromHint({ 'Product Hint': 'Manufacturing' }), null);
  assert.equal(categoryFromHint({}), null);
});
