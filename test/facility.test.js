'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { facilityKey, operatorToken, normalizeName } = require('../src/facility');

test('operator token drops common dairy and corporate suffixes', () => {
  assert.equal(operatorToken('GOSSNER FOODS, INC.'), 'gossner');
  assert.equal(operatorToken('SAPUTO DY FOODS USA LLC'), 'saputo');
  assert.equal(operatorToken('AGRI-MARK INC.'), 'agri');
  assert.equal(operatorToken('THE DAIRY OF CALIFORNIA'), 'california');
});

test('Gossner Logan variants share one facility key', () => {
  const a = facilityKey('GOSSNER FOODS', 'Logan', 'UT');                       // IMS
  const b = facilityKey('GOSSNER CHEESE CREAM LINE/RECEIVING', 'Logan', 'UT'); // IMS
  const c = facilityKey('GOSSNER FOODS, INC.', 'Logan', 'UT');                 // USDA
  assert.equal(a, b);
  assert.equal(b, c);
});

test('Different cities never merge', () => {
  const logan = facilityKey('GOSSNER FOODS', 'Logan', 'UT');
  const heyburn = facilityKey('GOSSNER FOODS', 'Heyburn', 'ID');
  assert.notEqual(logan, heyburn);
});

test('Different operators in same city stay separate', () => {
  const saputo = facilityKey('SAPUTO CHEESE USA', 'Tulare', 'CA');
  const land = facilityKey('LAND O LAKES', 'Tulare', 'CA');
  assert.notEqual(saputo, land);
});

test('Returns null for missing pieces (will not group)', () => {
  assert.equal(facilityKey('', 'Logan', 'UT'), null);
  assert.equal(facilityKey('Foo', '', 'UT'), null);
  assert.equal(facilityKey('Foo', 'Logan', ''), null);
});

test('normalizeName drops parentheticals like (BTU)', () => {
  assert.equal(normalizeName('PECAN POINT FM(BTU)'), 'pecan point fm');
  assert.equal(normalizeName('DFA(BTU)-NORTH CENTRAL'), 'dfa north central');
});
