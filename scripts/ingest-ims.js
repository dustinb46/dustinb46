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

// The IMS List is a multi-column table that pdf-parse flattens into a
// vertical stream. Each plant occupies three consecutive content lines:
//
//   DFA INC                          <- name
//   KNOXVILLE, TN                    <- city[, ST]
//   3224 1 91 --91 SHD 04/30/2025    <- plant#  product-codes  ratings  agency  exp-date
//
// State sections are introduced by a header line:
//   ALABAMA (STATECODE  01)
// and the full plant code is <statecode>-<plant#>, e.g. 01-3224.
//
// The reliable anchor is the data line: it starts with the plant number
// and ends with an MM/DD/YYYY date. Phone numbers, foreign single-service
// entries, and column headers don't match that shape, so they're skipped.

const STATE_NAME_TO_ABBR = {
  ALABAMA:'AL', ALASKA:'AK', ARIZONA:'AZ', ARKANSAS:'AR', CALIFORNIA:'CA',
  COLORADO:'CO', CONNECTICUT:'CT', DELAWARE:'DE', FLORIDA:'FL', GEORGIA:'GA',
  HAWAII:'HI', IDAHO:'ID', ILLINOIS:'IL', INDIANA:'IN', IOWA:'IA',
  KANSAS:'KS', KENTUCKY:'KY', LOUISIANA:'LA', MAINE:'ME', MARYLAND:'MD',
  MASSACHUSETTS:'MA', MICHIGAN:'MI', MINNESOTA:'MN', MISSISSIPPI:'MS', MISSOURI:'MO',
  MONTANA:'MT', NEBRASKA:'NE', NEVADA:'NV', 'NEW HAMPSHIRE':'NH', 'NEW JERSEY':'NJ',
  'NEW MEXICO':'NM', 'NEW YORK':'NY', 'NORTH CAROLINA':'NC', 'NORTH DAKOTA':'ND', OHIO:'OH',
  OKLAHOMA:'OK', OREGON:'OR', PENNSYLVANIA:'PA', 'RHODE ISLAND':'RI', 'SOUTH CAROLINA':'SC',
  'SOUTH DAKOTA':'SD', TENNESSEE:'TN', TEXAS:'TX', UTAH:'UT', VERMONT:'VT',
  VIRGINIA:'VA', WASHINGTON:'WA', 'WEST VIRGINIA':'WV', WISCONSIN:'WI', WYOMING:'WY',
  'PUERTO RICO':'PR', 'DISTRICT OF COLUMBIA':'DC',
};

// Column-header tokens that appear (each on its own line) at the top of
// every state section. Filtered out so they never enter the name/city
// window. Exact-match only, so they won't clip real names like
// "VENTURE MILK".
const HEADER_TOKENS = new Set([
  'NAME/CITY PLANT/BTU #', 'PRODUCT', 'CODES', 'RAW', 'MILK', 'RS/TR',
  'STATN', 'PLANT', 'ENFORCE', 'RATING', 'AGENCY', 'EXP RATING', 'DATE',
  'HACCP', 'LIST',
  'SANITATION COMPLIANCE AND ENFORCEMENT RATINGS OF INTERSTATE MILK SHIPPERS',
]);

const SECTION_RE = /^(.+?)\s*\(STATECODE\s+(\d+)\)\s*$/;
const PAGE_RE = /^PAGE:\s*\d+/i;
// plant# ... MM/DD/YYYY  (data/anchor line)
const DATA_RE = /^(\d{1,4})\s+(.*?)\s+(\d{2}\/\d{2}\/\d{4})\s*$/;
// rating agency token immediately before the date, e.g. SHD/SDA/OTH/HD
const AGENCY_RE = /\b([A-Z]{2,4})\s+\d{2}\/\d{2}\/\d{4}\s*$/;
const PLANT_RATING_RE = /--\s*(\d{2,3})\b/;

function stateAbbrFromName(name) {
  return STATE_NAME_TO_ABBR[name.trim().toUpperCase()] || null;
}

function isHeaderLine(line) {
  return HEADER_TOKENS.has(line.trim());
}

// Parse a data/anchor line into its structured fields. Returns null if it
// doesn't match the expected shape.
function parseDataLine(line) {
  const m = line.match(DATA_RE);
  if (!m) return null;
  const plantNum = m[1];
  const middle = m[2];
  const date = m[3];
  const agencyMatch = (middle + ' ' + date).match(AGENCY_RE);
  const ratingMatch = middle.match(PLANT_RATING_RE);
  return {
    plantNum,
    ims_rating: ratingMatch ? ratingMatch[1] : null,
    rating_agency: agencyMatch ? agencyMatch[1] : null,
    exp_date: date,
  };
}

// Split a city line into city + optional 2-letter state.
function parseCityLine(line) {
  const m = line.trim().match(/^(.*?),\s*([A-Z]{2})$/);
  if (m) return { city: m[1].trim(), state: m[2] };
  return { city: line.trim(), state: null };
}

// Pure parser: text -> { plants, parsed, skipped, skippedSamples }.
// No DB or filesystem dependency, so it can be unit-tested directly.
function parseImsText(text) {
  const lines = text.split('\n');
  const plants = [];
  let parsed = 0, skipped = 0;
  const skippedSamples = [];

  let stateCode = null;     // numeric statecode for current section, e.g. "01"
  let stateAbbr = null;     // postal abbrev, e.g. "AL"
  let recentContent = [];   // sliding window of recent name/city candidate lines

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '').trim();
    if (!line) continue;

    // Section header: update current state, reset the window.
    const section = line.match(SECTION_RE);
    if (section) {
      stateCode = section[2].padStart(2, '0');
      stateAbbr = stateAbbrFromName(section[1]);
      recentContent = [];
      continue;
    }

    if (PAGE_RE.test(line) || isHeaderLine(line)) continue;

    // Data/anchor line: the two preceding content lines are name + city.
    const data = parseDataLine(line);
    if (data) {
      parsed++;
      const name = recentContent.length >= 2 ? recentContent[recentContent.length - 2] : null;
      const cityLine = recentContent.length >= 1 ? recentContent[recentContent.length - 1] : null;
      recentContent = [];

      if (!stateCode || !name || !cityLine || name.length < 2) {
        skipped++;
        if (skippedSamples.length < 12) skippedSamples.push(line);
        continue;
      }
      const { city, state: cityState } = parseCityLine(cityLine);
      plants.push({
        plant_code: `${stateCode}-${data.plantNum}`,
        name: name.replace(/\s+/g, ' ').trim(),
        city,
        state: cityState || stateAbbr,
        ims_rating: data.ims_rating,
      });
      continue;
    }

    // Otherwise it's a name/city candidate; keep the last few.
    recentContent.push(line);
    if (recentContent.length > 4) recentContent.shift();
  }

  return { plants, parsed, skipped, skippedSamples };
}

async function main() {
  if (!fs.existsSync(PDF_PATH)) {
    console.error(`[ingest-ims] PDF not found at ${PDF_PATH}`);
    console.error(`[ingest-ims] run: npm run ims:download (with IMS_PDF_URL set)`);
    process.exit(2);
  }
  const runStarted = new Date().toISOString();
  const buf = fs.readFileSync(PDF_PATH);
  console.log(`[ingest-ims] parsing ${PDF_PATH} (${buf.length.toLocaleString()} bytes)`);
  const pdf = await pdfParse(buf);
  console.log(`[ingest-ims] extracted ${pdf.text.split('\n').length} lines from PDF`);

  const { plants, parsed, skipped, skippedSamples } = parseImsText(pdf.text);
  let written = 0;

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
    for (const p of plants) {
      upsert.run(p);
      insertAlias.run(p.plant_code, p.plant_code);
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
}

module.exports = { parseImsText, parseDataLine, parseCityLine };

// Run as a script (not when require()'d by a test).
if (require.main === module) {
  main().catch(err => {
    console.error('[ingest-ims] failed:', err);
    process.exit(1);
  });
}
