'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseUsdaText, codeCategory } = require('../scripts/ingest-usda');

const SAMPLE = [
  'SECTION I',
  '',
  'Plt No\t\tPlant Name\tCity\tCodes',
  '06 - CALIFORNIA',
  '50\t\tHILMAR CHEESE COMPANY, INC.\tHILMAR\tC3, C6, C7, M1, M2',
  '55\t\tLEPRINO FOODS COMPANY\tLEMOORE\tM1, M2',
  '49 - UTAH',
  '61\t\tGOSSNER FOODS, INC.\tLOGAN\tC3, C4, C38, M1, M2, M3',
  '50 - VERMONT',
  '19\t\tCABOT CREAMERY\tCABOT\tC3, C7, C12, M1, M2, S9, S16',
  '',
  'SECTION II',
  '',
  'Plt No\t\tPlant Name\tCity\tCodes',
  '06 - CALIFORNIA',
  '55\t\tLEPRINO FOODS COMPANY\tLEMOORE\tP3, P10, P28',
].join('\n');

test('parses USDA plants with USDA- prefixed codes', () => {
  const { plants } = parseUsdaText(SAMPLE);
  const hilmar = plants.find(p => p.plant_code === 'USDA-06-50');
  assert.ok(hilmar, 'Hilmar should parse');
  assert.equal(hilmar.name, 'HILMAR CHEESE COMPANY, INC.');
  assert.equal(hilmar.city, 'HILMAR');
  assert.equal(hilmar.state, 'CA');
});

test('maps FIPS state codes to postal abbreviations', () => {
  const { plants } = parseUsdaText(SAMPLE);
  assert.equal(plants.find(p => p.plant_code === 'USDA-49-61').state, 'UT');
  assert.equal(plants.find(p => p.plant_code === 'USDA-50-19').state, 'VT');
});

test('merges Section I and Section II codes for the same plant_no', () => {
  const { plants } = parseUsdaText(SAMPLE);
  const leprino = plants.find(p => p.plant_code === 'USDA-06-55');
  assert.ok(leprino);
  // Section I had M1, M2; Section II had P3, P10, P28 — all should be present.
  for (const code of ['M1', 'M2', 'P3', 'P10', 'P28']) {
    assert.ok(leprino.codes.includes(code), `expected merged code ${code}`);
  }
  assert.equal(leprino.section, 'I+II');
});

test('does not duplicate a plant that appears in both sections', () => {
  const { plants } = parseUsdaText(SAMPLE);
  const leprinos = plants.filter(p => p.plant_code === 'USDA-06-55');
  assert.equal(leprinos.length, 1, 'merged into a single row');
});

test('derives a category from product code prefixes', () => {
  assert.equal(codeCategory(['C3', 'C7', 'M1']), 'cheese');
  assert.equal(codeCategory(['F2', 'F9']), 'frozen dessert');
  assert.equal(codeCategory(['B1', 'B6']), 'butter');
  assert.equal(codeCategory(['D1', 'M1']), 'dry milk');
  assert.equal(codeCategory(['M1', 'M2']), 'fluid milk');
  assert.equal(codeCategory([]), null);
});
