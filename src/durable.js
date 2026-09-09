// Shared helpers for the durable-state export/import pair.
//
// Two things in this app are produced at runtime, live only in the SQLite
// file on the Railway volume, and are expensive or impossible to recreate:
//
//   1. Geocodes. Cheap per lookup but rate-limited to roughly one per
//      second by Nominatim, so a full run is 20-30 minutes of wall time
//      that cannot be hurried.
//   2. Recall overrides. Hand-typed corrections pinning a recall to a
//      plant. Nothing regenerates these. Lose the volume, lose the work.
//
// Everything else (plants, brands, brand mappings, recalls) already
// rebuilds from checked-in CSVs or a re-fetch. These two didn't, which is
// why a lapsed trial turned into data loss. They live in git now.

const path = require('path');

const DURABLE_DIR = path.join(__dirname, '..', 'data', 'durable');
const GEOCACHE_CSV = path.join(DURABLE_DIR, 'geocache.csv');
const OVERRIDES_CSV = path.join(DURABLE_DIR, 'recall-overrides.csv');

// Geocodes are keyed on the inputs that produced them, not on the plant.
// Keying on plant_code would silently reuse a stale coordinate after a
// DATCP refresh moves a plant to a new address; keying on the query means
// a changed address simply misses the cache and gets looked up again.
// It also dedupes naturally: every plant in a town shares one city row.
function geoKey(address, city, state) {
  const norm = (v) => (v == null ? '' : String(v).trim().toUpperCase().replace(/\s+/g, ' '));
  // JSON rather than a joined string: a separator character occurring
  // inside a field would otherwise let ("A|B", "C") and ("A", "B|C")
  // collide on the same key and cross-assign coordinates.
  return JSON.stringify([norm(address), norm(city), norm(state)]);
}

// Minimal RFC4180 quoting. Only quote when we have to, so the diffs stay
// readable — these files are reviewed in pull requests like any other
// source, and that is the whole point of keeping them in git.
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(columns, rows) {
  const lines = [columns.join(',')];
  for (const r of rows) lines.push(columns.map(c => csvCell(r[c])).join(','));
  return lines.join('\n') + '\n';
}

module.exports = { DURABLE_DIR, GEOCACHE_CSV, OVERRIDES_CSV, geoKey, csvCell, toCsv };
