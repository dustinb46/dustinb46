#!/usr/bin/env node
// Audit geocoded plants: any whose coordinates fall outside their stated
// state's bounding box are a bad geocode (Nominatim matched the wrong
// town). By default this is a REPORT — pass APPLY=1 to null those
// coordinates so the pins drop off the map until they can be
// re-geocoded correctly. Never deletes the plant record.

const { db } = require('../src/db');
const { isOutsideState } = require('../src/us-state-bounds');

const APPLY = process.env.APPLY === '1';

const rows = db.prepare(`
  SELECT id, plant_code, name, city, state, source, lat, lon
  FROM plants
  WHERE lat IS NOT NULL AND lon IS NOT NULL AND state IS NOT NULL
`).all();

const bad = rows.filter(r => isOutsideState(r.lat, r.lon, r.state));

console.log(`[verify-geo] ${rows.length} geocoded plants checked`);
console.log(`[verify-geo] ${bad.length} pinned outside their state${APPLY ? ' — nulling coords' : ' (report only)'}`);

const bySource = {};
for (const r of bad) bySource[r.source || '?'] = (bySource[r.source || '?'] || 0) + 1;
console.log('[verify-geo] bad pins by source:', JSON.stringify(bySource));

console.log('\nSample of flagged plants:');
for (const r of bad.slice(0, 30)) {
  console.log(`  ${(r.plant_code||'').padEnd(16)} ${(r.name||'').slice(0,32).padEnd(32)} listed ${r.city||'?'}, ${r.state}  ->  pin ${r.lat.toFixed(3)},${r.lon.toFixed(3)}`);
}

if (APPLY && bad.length) {
  const clear = db.prepare(`UPDATE plants SET lat = NULL, lon = NULL WHERE id = ?`);
  const txn = db.transaction(() => { for (const r of bad) clear.run(r.id); });
  txn();
  db.prepare(`
    INSERT INTO ingest_runs (source, started_at, finished_at, rows_in, rows_written, notes)
    VALUES ('verify-geo', datetime('now'), datetime('now'), ?, ?, ?)
  `).run(rows.length, bad.length, `nulled ${bad.length} out-of-state pins; by_source=${JSON.stringify(bySource)}`);
  console.log(`\n[verify-geo] nulled coordinates on ${bad.length} plants. Re-run geocode to retry them.`);
} else if (!APPLY) {
  console.log('\n[verify-geo] report only. Re-run with ?apply=1 to null these coordinates.');
}
