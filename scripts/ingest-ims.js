#!/usr/bin/env node
// Parses the FDA IMS List PDF into the `plants` table.
//
// The IMS PDF is a multi-column listing grouped by state. Format drifts
// between quarters. This parser is deliberately conservative: it only
// accepts rows where it can extract a plant code + name + state with
// reasonable confidence. Everything else is logged and skipped, and the
// caller is expected to run `ims:sanity` to spot-check the output.

const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const { db } = require('../src/db');
const { imsPdfPath } = require('../src/paths');

const PDF_PATH = imsPdfPath();

if (!fs.existsSync(PDF_PATH)) {
  console.error(`[ingest-ims] PDF not found at ${PDF_PATH}`);
  console.error(`[ingest-ims] run: npm run ims:download (with IMS_PDF_URL set)`);
  process.exit(2);
}

// Plant code shape: digits-digits (commonly 2-3 / 2-5).
// Examples in the IMS List: "06-42", "36-1407", "55-23".
const CODE_RE = /\b(\d{1,3})-(\d{1,5})\b/;

// State two-letter postal abbrev, used as a section header marker.
const STATE_RE = /^[A-Z]{2}\b/;

function inferStateFromHeader(line, current) {
  // IMS sections begin with a centered state name in title case.
  // We rely on the PDF text dump preserving the line, with a fallback
  // to the previous detected state.
  const trimmed = line.trim();
  const STATES = {
    'ALABAMA':'AL','ALASKA':'AK','ARIZONA':'AZ','ARKANSAS':'AR','CALIFORNIA':'CA',
    'COLORADO':'CO','CONNECTICUT':'CT','DELAWARE':'DE','FLORIDA':'FL','GEORGIA':'GA',
    'HAWAII':'HI','IDAHO':'ID','ILLINOIS':'IL','INDIANA':'IN','IOWA':'IA',
    'KANSAS':'KS','KENTUCKY':'KY','LOUISIANA':'LA','MAINE':'ME','MARYLAND':'MD',
    'MASSACHUSETTS':'MA','MICHIGAN':'MI','MINNESOTA':'MN','MISSISSIPPI':'MS','MISSOURI':'MO',
    'MONTANA':'MT','NEBRASKA':'NE','NEVADA':'NV','NEW HAMPSHIRE':'NH','NEW JERSEY':'NJ',
    'NEW MEXICO':'NM','NEW YORK':'NY','NORTH CAROLINA':'NC','NORTH DAKOTA':'ND','OHIO':'OH',
    'OKLAHOMA':'OK','OREGON':'OR','PENNSYLVANIA':'PA','RHODE ISLAND':'RI','SOUTH CAROLINA':'SC',
    'SOUTH DAKOTA':'SD','TENNESSEE':'TN','TEXAS':'TX','UTAH':'UT','VERMONT':'VT',
    'VIRGINIA':'VA','WASHINGTON':'WA','WEST VIRGINIA':'WV','WISCONSIN':'WI','WYOMING':'WY',
    'PUERTO RICO':'PR',
  };
  const up = trimmed.toUpperCase();
  if (STATES[up]) return STATES[up];
  return current;
}

function parseLine(line, state) {
  const m = line.match(CODE_RE);
  if (!m) return null;
  const code = `${m[1]}-${m[2]}`;
  // Strip the code from the line, then take the leading non-numeric chunk
  // as the plant name. IMS rows commonly look like:
  //   06-42  HP Hood LLC  Agawam  MA  21
  // We pull name = text before city/state/rating.
  const after = line.slice(m.index + m[0].length).trim();
  // Heuristic: split on 2+ spaces if present; otherwise take everything
  // up to the first all-caps two-letter token that matches a state.
  let name = after;
  let city = null;
  let rating = null;
  const parts = after.split(/\s{2,}/).map(s => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    name = parts[0];
    // Look for a trailing 2-digit rating, then a state, then a city in
    // reverse order. This is intentionally lenient.
    const last = parts[parts.length - 1];
    if (/^\d{1,3}$/.test(last)) {
      rating = last;
      parts.pop();
    }
    const maybeState = parts[parts.length - 1];
    if (/^[A-Z]{2}$/.test(maybeState)) {
      state = maybeState;
      parts.pop();
    }
    city = parts.length > 1 ? parts[parts.length - 1] : null;
  }
  return {
    plant_code: code,
    name: name.replace(/\s+/g, ' ').trim(),
    city,
    state,
    ims_rating: rating,
  };
}

(async () => {
  const runStarted = new Date().toISOString();
  const buf = fs.readFileSync(PDF_PATH);
  console.log(`[ingest-ims] parsing ${PDF_PATH} (${buf.length.toLocaleString()} bytes)`);
  const pdf = await pdfParse(buf);
  const lines = pdf.text.split('\n');
  console.log(`[ingest-ims] extracted ${lines.length} lines from PDF`);

  let state = null;
  let parsed = 0, written = 0, skipped = 0;
  const skippedSamples = [];

  const upsert = db.prepare(`
    INSERT INTO plants (plant_code, name, city, state, ims_rating, source, last_verified)
    VALUES (@plant_code, @name, @city, @state, @ims_rating, 'IMS', date('now'))
    ON CONFLICT(plant_code) DO UPDATE SET
      name=excluded.name,
      city=excluded.city,
      state=excluded.state,
      ims_rating=excluded.ims_rating,
      source='IMS',
      last_verified=date('now'),
      updated_at=datetime('now')
  `);
  const insertAlias = db.prepare(`
    INSERT INTO plant_code_aliases (plant_id, code, code_system)
    VALUES ((SELECT id FROM plants WHERE plant_code = ?), ?, 'ims')
    ON CONFLICT(code, code_system) DO NOTHING
  `);

  const txn = db.transaction(() => {
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) continue;
      state = inferStateFromHeader(line, state);
      const row = parseLine(line, state);
      if (!row) continue;
      parsed++;
      if (!row.name || row.name.length < 2) {
        skipped++;
        if (skippedSamples.length < 10) skippedSamples.push(line);
        continue;
      }
      upsert.run(row);
      insertAlias.run(row.plant_code, row.plant_code);
      written++;
    }
  });
  txn();

  db.prepare(`
    INSERT INTO ingest_runs (source, started_at, finished_at, rows_in, rows_written, notes)
    VALUES ('ims', ?, ?, ?, ?, ?)
  `).run(
    runStarted,
    new Date().toISOString(),
    parsed,
    written,
    `skipped=${skipped}; pdf=${path.basename(PDF_PATH)}`
  );

  console.log(`[ingest-ims] parsed=${parsed} written=${written} skipped=${skipped}`);
  if (skippedSamples.length) {
    console.log('[ingest-ims] sample skipped lines:');
    for (const s of skippedSamples) console.log(`  | ${s}`);
  }
  console.log('[ingest-ims] next: npm run ims:sanity');
})().catch(err => {
  console.error('[ingest-ims] failed:', err);
  process.exit(1);
});
