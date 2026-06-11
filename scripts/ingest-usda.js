#!/usr/bin/env node
// Parses the USDA AMS Approved Dairy Plant List into the `plants` table.
//
// USDA's list covers manufactured-product plants (cheese, butter, dry
// milk, frozen desserts) that IMS doesn't catch. A plant can appear in
// both Section I (USDA-graded) and Section II (P-code plants that share
// facilities but use unapproved-source ingredients) — same plant_no
// inside a state. We merge their product codes.
//
// USDA's plant numbers reuse the FIPS state prefix that IMS uses but with
// completely different numbering, so they would collide as bare codes.
// We namespace USDA codes as "USDA-NN-XXX" to keep them visually distinct
// and conflict-free with IMS.

const fs = require('fs');
const path = require('path');
const { db } = require('../src/db');

const USDA_PATH = process.env.USDA_LIST_PATH
  || path.join(__dirname, '..', 'data', 'usda', 'usda-list.txt');

// FIPS state code -> postal abbrev. The USDA file uses FIPS in headers
// ("01 - ALABAMA"), and IMS uses the same FIPS scheme.
const FIPS_TO_ABBR = {
  '01':'AL','02':'AK','04':'AZ','05':'AR','06':'CA','08':'CO','09':'CT','10':'DE','11':'DC',
  '12':'FL','13':'GA','15':'HI','16':'ID','17':'IL','18':'IN','19':'IA','20':'KS','21':'KY',
  '22':'LA','23':'ME','24':'MD','25':'MA','26':'MI','27':'MN','28':'MS','29':'MO','30':'MT',
  '31':'NE','32':'NV','33':'NH','34':'NJ','35':'NM','36':'NY','37':'NC','38':'ND','39':'OH',
  '40':'OK','41':'OR','42':'PA','43':'PR','44':'RI','45':'SC','46':'SD','47':'TN','48':'TX',
  '49':'UT','50':'VT','51':'VA','53':'WA','54':'WV','55':'WI','56':'WY',
};

const SECTION_HEADER_RE = /^SECTION\s+(I{1,2})\b/;
const STATE_HEADER_RE = /^(\d{1,2})\s*-\s*([A-Z .]+?)(?:\s+Continued)?\s*$/;
const COLUMN_HEADER_RE = /^Plt\s*No\b.*Plant\s*Name\b.*City\b.*Codes\b/i;

// Map product-code prefixes to a high-level category for display + search.
function codeCategory(codes) {
  if (!codes || !codes.length) return null;
  const has = (p) => codes.some(c => c.startsWith(p));
  if (has('C')) return 'cheese';
  if (has('F')) return 'frozen dessert';
  if (has('B')) return 'butter';
  if (has('D')) return 'dry milk';
  if (has('W')) return 'whey';
  if (has('S')) return 'specialty';
  if (has('M')) return 'fluid milk';
  if (has('P')) return 'packaging/processing';
  return null;
}

function splitFields(rawLine) {
  // Rows are tab-separated. The 2nd column ("resident plant" marker)
  // is sometimes "*", sometimes empty -> two tabs in a row.
  return rawLine.replace(/\r$/, '').split('\t');
}

function looksLikePlantRow(line) {
  // Plant rows start with a number (the plant_no), have at least 4
  // tab-separated fields, and end with a comma-separated code list.
  // Reject section/column/state headers cleanly.
  const fields = splitFields(line);
  if (fields.length < 4) return false;
  if (!/^\d+$/.test(fields[0].trim())) return false;
  const last = fields[fields.length - 1].trim();
  // Code lists start with B/C/D/F/M/S/W/P and a digit.
  return /^[BCDFMSWP]\d/.test(last);
}

function parsePlantRow(line) {
  const fields = splitFields(line).map(f => f.trim());
  // Find the first field that looks like a code list — everything before
  // it (except the leading plant_no and optional resident marker) is the
  // name+city. Most rows shape as: [plant_no, "" or "*", name, city, codes].
  // A handful split city/state oddly; treat the field before codes as city.
  const plant_no = fields[0];
  const isResident = fields[1] === '*';
  const codeStr = fields[fields.length - 1];
  const codes = codeStr.split(',').map(c => c.trim()).filter(Boolean);
  // Name and city are the two fields between resident-marker and codes.
  const middle = fields.slice(isResident ? 2 : 1, -1).filter(Boolean);
  // Drop a possible blank slot when resident wasn't marked.
  const cleaned = middle.filter(s => s !== '');
  let name = '', city = '';
  if (cleaned.length >= 2) {
    city = cleaned[cleaned.length - 1];
    name = cleaned.slice(0, -1).join(' ');
  } else if (cleaned.length === 1) {
    name = cleaned[0];
  }
  return { plant_no, isResident, name, city, codes };
}

function parseUsdaText(text) {
  const lines = text.split('\n');
  const plants = new Map(); // key: `${state_fips}-${plant_no}` -> plant
  let stateFips = null;
  let section = null;
  let parsed = 0, skipped = 0;
  const skippedSamples = [];

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;

    const sec = line.match(SECTION_HEADER_RE);
    if (sec) { section = sec[1]; continue; }

    const sh = line.trim().match(STATE_HEADER_RE);
    if (sh) {
      const fips = sh[1].padStart(2, '0');
      if (FIPS_TO_ABBR[fips]) { stateFips = fips; continue; }
    }

    if (COLUMN_HEADER_RE.test(line)) continue;

    if (!looksLikePlantRow(line)) {
      // Preamble, page headers, footnotes — quietly skip.
      continue;
    }

    if (!stateFips) {
      skipped++;
      if (skippedSamples.length < 10) skippedSamples.push(line);
      continue;
    }

    parsed++;
    const row = parsePlantRow(line);
    if (!row.name || !row.plant_no) {
      skipped++;
      if (skippedSamples.length < 10) skippedSamples.push(line);
      continue;
    }
    const key = `${stateFips}-${row.plant_no}`;
    const existing = plants.get(key);
    if (existing) {
      // Section II merges into Section I (or vice versa) for the same plant_no.
      const merged = new Set([...existing.codes, ...row.codes]);
      existing.codes = [...merged];
      existing.section = existing.section === section ? section : 'I+II';
      if (row.isResident) existing.resident = true;
      if (!existing.city && row.city) existing.city = row.city;
      continue;
    }
    plants.set(key, {
      plant_code: `USDA-${stateFips}-${row.plant_no}`,
      usda_state_fips: stateFips,
      usda_plant_no: row.plant_no,
      name: row.name,
      city: row.city || null,
      state: FIPS_TO_ABBR[stateFips],
      codes: row.codes,
      section,
      resident: row.isResident,
    });
  }

  return {
    plants: [...plants.values()].map(p => ({
      ...p,
      category: codeCategory(p.codes),
    })),
    parsed,
    skipped,
    skippedSamples,
  };
}

async function main() {
  if (!fs.existsSync(USDA_PATH)) {
    console.error(`[ingest-usda] file not found at ${USDA_PATH}`);
    process.exit(2);
  }
  const runStarted = new Date().toISOString();
  const text = fs.readFileSync(USDA_PATH, 'utf8');
  console.log(`[ingest-usda] parsing ${USDA_PATH} (${text.length.toLocaleString()} chars)`);

  const { plants, parsed, skipped, skippedSamples } = parseUsdaText(text);

  const upsert = db.prepare(`
    INSERT INTO plants (plant_code, name, city, state, category, source, last_verified)
    VALUES (@plant_code, @name, @city, @state, @category, 'USDA-AMS', date('now'))
    ON CONFLICT(plant_code) DO UPDATE SET
      name=excluded.name,
      city=excluded.city,
      state=excluded.state,
      category=excluded.category,
      source='USDA-AMS',
      last_verified=date('now'),
      updated_at=datetime('now')
  `);
  const insertAlias = db.prepare(`
    INSERT INTO plant_code_aliases (plant_id, code, code_system, notes)
    VALUES ((SELECT id FROM plants WHERE plant_code = ?), ?, 'usda', ?)
    ON CONFLICT(code, code_system) DO UPDATE SET notes = excluded.notes
  `);

  let written = 0, removed = 0;
  const txn = db.transaction(() => {
    const seen = new Set();
    for (const p of plants) {
      upsert.run(p);
      const noteText = `USDA codes: ${p.codes.join(', ')}; section ${p.section || '?'}${p.resident ? '; resident' : ''}`;
      insertAlias.run(p.plant_code, p.plant_code, noteText);
      // Bare USDA code (without prefix) too, so a recall mentioning e.g. "55-322"
      // can resolve to this plant via the alias lookup. Skipped if it would collide.
      const bare = `${p.usda_state_fips}-${p.usda_plant_no}`;
      try { insertAlias.run(p.plant_code, bare, `USDA bare code ${bare}`); } catch { /* unique conflict */ }
      seen.add(p.plant_code);
      written++;
    }
    // Reconcile orphans from prior USDA ingests.
    const existing = db.prepare(
      `SELECT plant_code FROM plants WHERE source = 'USDA-AMS'`
    ).all();
    const del = db.prepare(`DELETE FROM plants WHERE plant_code = ? AND source = 'USDA-AMS'`);
    for (const row of existing) {
      if (!seen.has(row.plant_code)) {
        del.run(row.plant_code);
        removed++;
      }
    }
  });
  txn();

  db.prepare(`
    INSERT INTO ingest_runs (source, started_at, finished_at, rows_in, rows_written, notes)
    VALUES ('usda', ?, ?, ?, ?, ?)
  `).run(
    runStarted, new Date().toISOString(),
    parsed, written,
    `skipped=${skipped} removed=${removed}; file=${path.basename(USDA_PATH)}`
  );

  console.log(`[ingest-usda] parsed=${parsed} written=${written} removed=${removed} skipped=${skipped}`);
  if (skippedSamples.length) {
    console.log('[ingest-usda] sample skipped lines:');
    for (const s of skippedSamples) console.log(`  | ${s}`);
  }
}

module.exports = { parseUsdaText, parsePlantRow, codeCategory };

if (require.main === module) {
  main().catch(err => {
    console.error('[ingest-usda] failed:', err);
    process.exit(1);
  });
}
