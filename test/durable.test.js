const test = require('node:test');
const assert = require('node:assert');
const { geoKey, csvCell, toCsv } = require('../src/durable');

test('geoKey ignores case and surrounding whitespace', () => {
  assert.equal(geoKey('1540 Vision Dr', 'Platteville', 'WI'),
               geoKey('  1540 VISION DR ', ' platteville ', 'wi'));
});

test('geoKey collapses repeated internal whitespace', () => {
  assert.equal(geoKey('600  1st   Ave', 'Clear Lake', 'WI'),
               geoKey('600 1st Ave', 'Clear Lake', 'WI'));
});

test('geoKey treats a missing address the same as an empty one', () => {
  assert.equal(geoKey(null, 'Tempe', 'AZ'), geoKey('', 'Tempe', 'AZ'));
});

test('geoKey separates a street lookup from its city lookup', () => {
  // These resolve differently (building pin vs town centroid) and must
  // never share a cache entry.
  assert.notEqual(geoKey('1540 Vision Dr', 'Platteville', 'WI'),
                  geoKey(null, 'Platteville', 'WI'));
});

test('geoKey does not let field contents collide across the separator', () => {
  assert.notEqual(geoKey('A|B', 'C', 'WI'), geoKey('A', 'B|C', 'WI'));
});

test('csvCell quotes only when it has to', () => {
  assert.equal(csvCell('Platteville'), 'Platteville');
  assert.equal(csvCell('Clear Lake'), 'Clear Lake');
  assert.equal(csvCell(null), '');
});

test('csvCell escapes commas, quotes and newlines', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('two\nlines'), '"two\nlines"');
});

test('toCsv round-trips a note containing commas and quotes', () => {
  const { parse } = require('csv-parse/sync');
  const note = 'Confirmed via press release, and "quoted" text';
  const csv = toCsv(['recall_number', 'plant_code', 'note'],
                    [{ recall_number: 'F-1234-2026', plant_code: 'USDA-55-322', note }]);
  const back = parse(csv, { columns: true, skip_empty_lines: true, trim: true });
  assert.equal(back.length, 1);
  assert.equal(back[0].note, note);
  assert.equal(back[0].plant_code, 'USDA-55-322');
});
