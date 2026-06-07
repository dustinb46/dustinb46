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

const checks = [
  ['name shorter than 3 chars',  `SELECT COUNT(*) AS n FROM plants WHERE source='IMS' AND LENGTH(TRIM(name)) < 3`],
  ['state missing',              `SELECT COUNT(*) AS n FROM plants WHERE source='IMS' AND (state IS NULL OR state='')`],
  ['city missing',               `SELECT COUNT(*) AS n FROM plants WHERE source='IMS' AND (city IS NULL OR city='')`],
  ['code lacks dash',            `SELECT COUNT(*) AS n FROM plants WHERE source='IMS' AND plant_code NOT LIKE '%-%'`],
  ['name contains plant code',   `SELECT COUNT(*) AS n FROM plants WHERE source='IMS' AND name GLOB '*[0-9]-[0-9]*'`],
  ['duplicate codes',            `SELECT COUNT(*) AS n FROM (SELECT plant_code FROM plants WHERE source='IMS' GROUP BY plant_code HAVING COUNT(*)>1)`],
];

console.log('\nRed-flag counts:');
let anyRed = false;
for (const [label, sql] of checks) {
  const n = db.prepare(sql).get().n;
  const flag = n > 0 ? '!!' : '  ';
  if (n > 0) anyRed = true;
  console.log(`  ${flag} ${label.padEnd(28)} ${n}`);
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
