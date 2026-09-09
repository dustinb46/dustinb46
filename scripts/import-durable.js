#!/usr/bin/env node
// Restores geocodes and recall overrides from data/durable/ into the
// database. Runs on every container start (see "prestart"), so a fresh
// volume comes back with its map and its hand corrections intact instead
// of needing half an hour of rate-limited geocoding.
//
//   npm run durable:import              fill gaps only (default)
//   DURABLE_FORCE=1 npm run durable:import   overwrite existing coordinates
//
// Deliberately offline and non-fatal: a deploy must never fail, hang, or
// wait on this. Anything it cannot restore is reported and skipped.

const fs = require('fs');
const { parse } = require('csv-parse/sync');
const { db } = require('../src/db');
const { GEOCACHE_CSV, OVERRIDES_CSV, geoKey } = require('../src/durable');

const FORCE = process.env.DURABLE_FORCE === '1';

function readCsv(file) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  return parse(text, { columns: true, skip_empty_lines: true, trim: true });
}

function importGeocodes() {
  const rows = readCsv(GEOCACHE_CSV);
  if (!rows) return console.log('[durable:import] geocache   no file yet, skipping');

  const cache = new Map();
  let bad = 0;
  for (const r of rows) {
    const lat = parseFloat(r.lat), lon = parseFloat(r.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) { bad++; continue; }
    cache.set(geoKey(r.address, r.city, r.state), { lat, lon });
  }

  // Only fill plants that have no coordinate. A row already geocoded in
  // this database is at least as fresh as the file, and overwriting it
  // would quietly undo a manual correction.
  const targets = db.prepare(`
    SELECT id, address, city, state FROM plants
    WHERE city IS NOT NULL AND state IS NOT NULL
      ${FORCE ? '' : 'AND (lat IS NULL OR lon IS NULL)'}
  `).all();

  const update = db.prepare(`
    UPDATE plants SET lat = ?, lon = ?, geocoded_at = COALESCE(geocoded_at, datetime('now'))
    WHERE id = ?
  `);

  let hit = 0, missed = 0;
  const apply = db.transaction((list) => {
    for (const p of list) {
      const c = cache.get(geoKey(p.address, p.city, p.state));
      if (c) { update.run(c.lat, c.lon, p.id); hit++; } else { missed++; }
    }
  });
  apply(targets);

  console.log(`[durable:import] geocache   ${cache.size} cached lookups; restored ${hit} plant(s), ${missed} still need geocoding` +
    (bad ? `, ${bad} unparseable row(s)` : ''));
  if (missed) console.log(`[durable:import]            run "npm run geocode" to fill the remaining ${missed}, then "npm run durable:export"`);
}

function importOverrides() {
  const rows = readCsv(OVERRIDES_CSV);
  if (!rows) return console.log('[durable:import] overrides  no file yet, skipping');

  const findPlant = db.prepare('SELECT id FROM plants WHERE plant_code = ?');
  const upsert = db.prepare(`
    INSERT INTO recall_overrides (recall_number, plant_id, note, created_at)
    VALUES (?, ?, ?, COALESCE(?, datetime('now')))
    ON CONFLICT(recall_number) DO UPDATE SET
      plant_id = excluded.plant_id,
      note     = excluded.note
  `);

  let ok = 0;
  const unresolved = [];
  const apply = db.transaction((list) => {
    for (const r of list) {
      if (!r.recall_number) continue;
      const p = r.plant_code ? findPlant.get(r.plant_code) : null;
      if (!p) { unresolved.push(r); continue; }
      upsert.run(r.recall_number, p.id, r.note || null, r.created_at || null);
      ok++;
    }
  });
  apply(rows);

  console.log(`[durable:import] overrides  restored ${ok}/${rows.length}`);
  // Loud, because a dropped override is lost human judgement, not data
  // that regenerates. Usually it means the plant ingest hasn't run yet.
  for (const r of unresolved) {
    console.warn(`[durable:import] WARNING override ${r.recall_number} skipped: ` +
      `plant_code ${r.plant_code || '(none)'} not in the database`);
  }
}

try {
  importGeocodes();
  importOverrides();
} catch (e) {
  // Never block a boot on this.
  console.error(`[durable:import] FAILED (continuing anyway): ${e.message}`);
}
