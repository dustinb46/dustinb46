#!/usr/bin/env node
// Sanity-checks the most recent IMS ingest. Prints 10 random plant rows
// and a set of red-flag counts so you can eyeball whether the parser is
// producing trustworthy data.

const { db } = require('../src/db');

const total = db.prepare(`SELECT COUNT(*) AS n FROM plants WHERE source = 'IMS'`).get().n;
if (total === 0) {
  console.log('[sanity] no IMS-sourced plants in DB. Run npm run ims:ingest first.');
  process.exit(0);
}

console.log(`[sanity] IMS plant count: ${total}`);

// Each check has a WHERE clause; we both count and (when non-zero) print
// the offending rows so they can be eyeballed instead of guessed at.
const checks = [
  ['name shorter than 3 chars', `LENGTH(TRIM(name)) < 3`],
  ['state missing',             `(state IS NULL OR state='')`],
  ['city missing',              `(city IS NULL OR city='')`],
  ['code lacks dash',           `plant_code NOT LIKE '%-%'`],
  ['name contains plant code',  `name GLOB '*[0-9]-[0-9]*'`],
];

console.log('\nRed-flag counts:');
let anyRed = false;
const flagged = [];
for (const [label, where] of checks) {
  const n = db.prepare(
    `SELECT COUNT(*) AS n FROM plants WHERE source='IMS' AND ${where}`
  ).get().n;
  const flag = n > 0 ? '!!' : '  ';
  if (n > 0) { anyRed = true; flagged.push([label, where]); }
  console.log(`  ${flag} ${label.padEnd(28)} ${n}`);
}

// duplicate codes is a grouping check, handled separately
const dupes = db.prepare(
  `SELECT plant_code, COUNT(*) AS n FROM plants WHERE source='IMS'
   GROUP BY plant_code HAVING COUNT(*) > 1`
).all();
console.log(`  ${dupes.length ? '!!' : '  '} ${'duplicate codes'.padEnd(28)} ${dupes.length}`);
if (dupes.length) anyRed = true;

for (const [label, where] of flagged) {
  console.log(`\n  rows flagged by "${label}":`);
  const rows = db.prepare(
    `SELECT plant_code, name, city, state FROM plants
     WHERE source='IMS' AND ${where} LIMIT 20`
  ).all();
  for (const r of rows) {
    console.log(`    ${r.plant_code.padEnd(10)} ${(r.name || '').padEnd(40)} ${(r.city || '')}, ${r.state || ''}`);
  }
}

console.log('\nRandom sample of 10 rows (verify these against the PDF):');
const sample = db.prepare(
  `SELECT plant_code, name, city, state, ims_rating
   FROM plants WHERE source='IMS' ORDER BY RANDOM() LIMIT 10`
).all();
for (const r of sample) {
  console.log(`  ${r.plant_code.padEnd(10)} ${(r.name || '').padEnd(40)} ${(r.city || '').padEnd(20)} ${r.state || ''}  rating=${r.ims_rating || ''}`);
}

if (anyRed) {
  console.log('\n[sanity] red flags present. Inspect the parser before trusting this data.');
  process.exit(1);
}
console.log('\n[sanity] no red flags. Still spot-check the random sample above.');
