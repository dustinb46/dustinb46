#!/usr/bin/env node
// Resolve plant codes for a batch of name queries in one shot, so brand
// mappings can be built against exact codes. Reads a comma-separated list
// from IMS_QUERIES.
//
//   IMS_QUERIES="gossner,rutter,smith dairy" node scripts/resolve-plants.js

const { db } = require('../src/db');

const raw = process.env.IMS_QUERIES || process.argv[2] || '';
const queries = raw.split(',').map(s => s.trim()).filter(Boolean);

if (!queries.length) {
  console.error('[resolve] no queries. Set IMS_QUERIES="name1,name2,..."');
  process.exit(2);
}

function ftsQuery(s) {
  return s.split(/\s+/).filter(Boolean)
    .map(t => `"${t.replace(/"/g, '""')}"*`).join(' ');
}

const search = db.prepare(`
  SELECT p.plant_code, p.name, p.city, p.state
  FROM plants_fts JOIN plants p ON p.id = plants_fts.rowid
  WHERE plants_fts MATCH ?
  ORDER BY rank LIMIT 8
`);

for (const q of queries) {
  console.log(`\n## ${q}`);
  let rows = [];
  try { rows = search.all(ftsQuery(q)); } catch (e) { console.log(`  (query error: ${e.message})`); continue; }
  if (!rows.length) { console.log('  (no matches)'); continue; }
  for (const r of rows) {
    console.log(`  ${r.plant_code.padEnd(10)} ${(r.name || '').padEnd(42)} ${(r.city || '')}, ${r.state || ''}`);
  }
}
