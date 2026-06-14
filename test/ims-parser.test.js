'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseImsText } = require('../scripts/ingest-ims');

// Verbatim slices of the real IMS PDF text (post pdf-parse flattening),
// covering the cases that broke earlier parser versions.
const ALABAMA = [
  'SANITATION COMPLIANCE AND ENFORCEMENT RATINGS OF INTERSTATE MILK SHIPPERS',
  'ALABAMA (STATECODE  01)',
  'NAME/CITY PLANT/BTU #', 'PRODUCT', 'CODES', 'RAW', 'MILK', 'RS/TR',
  'STATN', 'PLANT', 'ENFORCE', 'RATING', 'RATING', 'AGENCY', 'EXP RATING',
  'DATE', 'HACCP', 'LIST',
  'DFA INC', 'KNOXVILLE, TN', '3224 1 91 --91 SHD 04/30/2025',
  'SAPUTO DY FOODS USA LLC', 'DECATUR', '5201 1, 5-04, 26 90 --95 SHD 01/31/2025',
  'VENTURE MILK', 'SLOCOMB', '3401 1, 2, 4, 8, 17 90 --92 SHD 12/31/2025',
].join('\n');

test('parses a basic three-line plant record', () => {
  const { plants } = parseImsText(ALABAMA);
  const dfa = plants.find(p => p.plant_code === '01-3224');
  assert.ok(dfa, 'DFA plant should be parsed');
  assert.equal(dfa.name, 'DFA INC');
  assert.equal(dfa.city, 'KNOXVILLE');
  assert.equal(dfa.state, 'TN', 'out-of-section city keeps its own state');
  assert.equal(dfa.ims_rating, '91');
});

test('uses the section state when the city line has no state', () => {
  const { plants } = parseImsText(ALABAMA);
  const venture = plants.find(p => p.plant_code === '01-3401');
  assert.equal(venture.state, 'AL', 'in-section plant inherits section state');
  assert.equal(venture.city, 'SLOCOMB');
});

test('does NOT mistake product codes like 5-04 for the plant code', () => {
  const { plants } = parseImsText(ALABAMA);
  // The plant number is 5201, not 5-04 from the product code list.
  assert.ok(plants.find(p => p.plant_code === '01-5201'));
  assert.ok(!plants.find(p => p.plant_code === '01-5'), 'product code must not become a plant code');
  assert.ok(!plants.find(p => p.plant_code.includes('5-04')));
});

test('builds the code as <statecode>-<plantnumber>', () => {
  const { plants } = parseImsText(ALABAMA);
  for (const p of plants) {
    assert.match(p.plant_code, /^01-\d+$/, `${p.plant_code} should be in the 01-NNN form`);
  }
});

test('strips an inline parenthetical code from the name', () => {
  const text = [
    'CALIFORNIA (STATECODE  41)',
    'NAME/CITY PLANT/BTU #', 'PRODUCT', 'CODES', 'RAW', 'MILK',
    'CYPRESS GROVE BTU(41-134)', 'ARCATA, CA', '134 1 95 --99 SDA 06/30/2026',
  ].join('\n');
  const { plants } = parseImsText(text);
  const cg = plants.find(p => p.plant_code === '41-134');
  assert.ok(cg);
  assert.equal(cg.name, 'CYPRESS GROVE BTU', 'inline (41-134) should be stripped');
});

test('ignores phone numbers, dates, and email lines', () => {
  const text = [
    'OHIO (STATECODE  39)',
    'NAME/CITY PLANT/BTU #', 'PRODUCT', 'CODES', 'RAW', 'MILK',
    'REAL DAIRY CO', 'COLUMBUS', '100 1 90 --95 SDA 04/30/2025',
    'Cell: (717) 364-6606',
    '(FAX) (717) 541-9927',
    'someone@fda.hhs.gov',
  ].join('\n');
  const { plants } = parseImsText(text);
  assert.equal(plants.length, 1, 'only the real plant should parse');
  assert.equal(plants[0].plant_code, '39-100');
});

test('handles multiple states in one stream', () => {
  const text = [
    'ALABAMA (STATECODE  01)',
    'NAME/CITY PLANT/BTU #', 'PRODUCT',
    'PLANT ONE', 'MOBILE', '10 1 90 --95 SHD 04/30/2025',
    'ALASKA (STATECODE  02)',
    'NAME/CITY PLANT/BTU #', 'PRODUCT',
    'PLANT TWO', 'JUNEAU', '20 1 90 --95 OTH 04/30/2025',
  ].join('\n');
  const { plants } = parseImsText(text);
  assert.equal(plants.find(p => p.plant_code === '01-10').state, 'AL');
  assert.equal(plants.find(p => p.plant_code === '02-20').state, 'AK');
});
