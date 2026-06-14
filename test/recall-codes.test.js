'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { extractCodes, normCode } = require('../scripts/harvest-recall-codes');

test('extracts a PLT-prefixed plant code', () => {
  const codes = [...extractCodes('code date DEC08, plant code: PLT19-145, produced 17:51')];
  assert.deepEqual(codes, ['19-145']);
});

test('extracts a code from explicit "Plant Code" context', () => {
  const codes = [...extractCodes('Chocolate Ice Cream UPC: 83057 17049 Plant Code 29-050')];
  assert.deepEqual(codes, ['29-050']);
});

test('does NOT extract best-by dates or lot fragments', () => {
  assert.equal(extractCodes('BEST BY 12-25 LOT 4451').size, 0);
  assert.equal(extractCodes('EXP 11-30, sell by 03-31').size, 0);
  assert.equal(extractCodes('UPC 0 78742 37339 3').size, 0);
});

test('handles PLT with spaces and hash variations', () => {
  assert.deepEqual([...extractCodes('PLT 55-322')], ['55-322']);
  assert.deepEqual([...extractCodes('PLT# 06-71')], ['06-71']);
  assert.deepEqual([...extractCodes('plant no. 24-801')], ['24-801']);
});

test('extracts multiple distinct codes from one string', () => {
  const codes = [...extractCodes('made at plant code 19-145 and plant code 06-71')];
  assert.deepEqual(codes.sort(), ['06-71', '19-145']);
});

test('normCode strips zero padding for stable comparison', () => {
  assert.equal(normCode('01-0326'), '1-326');
  assert.equal(normCode('39-020'), '39-20');
  assert.equal(normCode('06-71'), '6-71');
});

test('normCode and a padded variant collapse to the same key', () => {
  assert.equal(normCode('01-0326'), normCode('1-326'));
  assert.equal(normCode('39-20'), normCode('39-020'));
});

test('normCode rejects non-code strings', () => {
  assert.equal(normCode('not-a-code'), null);
  assert.equal(normCode('123456'), null);
  assert.equal(normCode(''), null);
});
