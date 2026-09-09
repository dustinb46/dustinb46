#!/usr/bin/env node
// Dumps the runtime-produced state that nothing else can rebuild into
// CSVs under data/durable/, so it survives a lost volume. Safe to run
// any time; it only reads the database.
//
//   npm run durable:export
//
// Commit the result. Git history then doubles as the audit trail for
// coordinate and override changes, the same way the brand CSVs work.

const fs = require('fs');
const { db } = require('../src/db');
const { DURABLE_DIR, GEOCACHE_CSV, OVERRIDES_CSV, geoKey, toCsv } = require('../src/durable');

fs.mkdirSync(DURABLE_DIR, { recursive: true });

// ---- geocodes ----------------------------------------------------------
// One row per distinct (address, city, state) that resolved, not one per
// plant. A plant whose street address failed and fell back to the town
// centre is stored under its own address with the centroid coordinate,
// which is exactly what should be restored for it later.
const geoRows = db.prepare(`
  SELECT address, city, state, lat, lon, geocoded_at
  FROM plants
  WHERE lat IS NOT NULL AND lon IS NOT NULL
  ORDER BY geocoded_at DESC
`).all();

// Collapse to one row per lookup key. Done in JS rather than SQL so the
// key matches geoKey() exactly, which is what the importer will use.
// Rows arrive newest-first, so the first hit for a key is the freshest.
const seen = new Map();
for (const r of geoRows) {
  const k = geoKey(r.address, r.city, r.state);
  if (!seen.has(k)) seen.set(k, r);
}
const geo = [...seen.values()]
  .map(r => ({
    address: r.address || '',
    city: r.city,
    state: r.state,
    lat: Number(r.lat).toFixed(6),
    lon: Number(r.lon).toFixed(6),
    geocoded_at: r.geocoded_at || '',
  }))
  // Stable sort so re-exports produce minimal diffs rather than churn.
  .sort((a, b) => (a.state + a.city + a.address).localeCompare(b.state + b.city + b.address));

fs.writeFileSync(GEOCACHE_CSV, toCsv(['address', 'city', 'state', 'lat', 'lon', 'geocoded_at'], geo));

// ---- recall overrides --------------------------------------------------
// plant_id is an autoincrement rowid and means nothing after a rebuild,
// so overrides are exported against plant_code and re-resolved on import.
const overrides = db.prepare(`
  SELECT o.recall_number, p.plant_code, o.note, o.created_at
  FROM recall_overrides o
  LEFT JOIN plants p ON p.id = o.plant_id
  ORDER BY o.recall_number
`).all();

const orphaned = overrides.filter(o => !o.plant_code).length;
fs.writeFileSync(OVERRIDES_CSV,
  toCsv(['recall_number', 'plant_code', 'note', 'created_at'], overrides));

console.log(`[durable:export] geocache      ${geo.length} rows -> ${GEOCACHE_CSV}`);
console.log(`[durable:export] overrides     ${overrides.length} rows -> ${OVERRIDES_CSV}`);
if (orphaned) {
  console.warn(`[durable:export] WARNING ${orphaned} override(s) point at a plant_id that no longer exists; ` +
    `exported with an empty plant_code and will be skipped on import.`);
}
console.log('[durable:export] commit data/durable/ to make this survive the next deploy.');
