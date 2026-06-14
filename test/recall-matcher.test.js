'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { normState, jaccard, matchPlant } = require('../scripts/sync-recalls');

test('normState handles full names and abbreviations', () => {
  assert.equal(normState('California'), 'CA');
  assert.equal(normState('WISCONSIN'), 'WI');
  assert.equal(normState('wi'), 'WI');
  assert.equal(normState('New York'), 'NY');
  assert.equal(normState(''), null);
  assert.equal(normState('Nowhere'), null);
});

test('jaccard is 1 for identical token sets and 0 for disjoint', () => {
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
  assert.equal(jaccard(new Set(['a']), new Set(['b'])), 0);
});

const PLANTS = [
  { id: 1, name: 'WESTBY COOP CREAMERY', city: 'WESTBY', state: 'WI' },
  { id: 2, name: 'SAPUTO CHEESE USA', city: 'TULARE', state: 'CA', parent_company: 'Saputo Inc' },
  { id: 3, name: 'PRAIRIE FARMS DAIRY', city: 'CARLINVILLE', state: 'IL' },
];

test('matches a recalling firm to the right plant by name', () => {
  const m = matchPlant('Westby Cooperative Creamery', 'Westby', 'Wisconsin', PLANTS);
  assert.equal(m.plant.id, 1);
  assert.ok(m.score >= 0.7, `expected strong score, got ${m.score}`);
});

test('same-state geography boosts the score', () => {
  const withGeo = matchPlant('Saputo Cheese', 'Tulare', 'California', PLANTS);
  const noGeo = matchPlant('Saputo Cheese', 'Nowhere', 'Texas', PLANTS);
  assert.equal(withGeo.plant.id, 2);
  assert.ok(withGeo.score > noGeo.score, 'matching geography should score higher');
});

test('matches against parent_company as an alternate name', () => {
  const m = matchPlant('Saputo Inc', null, null, PLANTS);
  assert.equal(m.plant.id, 2, 'should match via parent_company');
});

test('returns null when nothing shares meaningful tokens', () => {
  const m = matchPlant('Totally Unrelated Bakery', 'Boston', 'MA', PLANTS);
  assert.ok(m === null || m.score < 0.35, 'no real match should fall below threshold');
});
