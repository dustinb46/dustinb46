#!/usr/bin/env node
// Parses the Wisconsin DATCP "Public Dairy Plant License Holders" CSV
// into the `plants` table. WI alone publishes ~770 licensed dairy
// plants, most of which IMS and USDA skip because federal grading is
// voluntary. Cream cheese makers, butter shops, small creameries,
// cheese plants — this is where the WI long tail lives.
//
// The WIPlantNo column is already in the same NN-XXX format as IMS
// codes (because both use FIPS state code prefixes), so DATCP rows
// naturally collide with IMS rows for the same physical plant. Policy:
// when a plant_code already exists, fill missing fields (mostly
// street address) but never overwrite values another source already
// set. This adds the DATCP data layer without disturbing IMS.
//
// Output: plants get inserted with source='WI-DATCP' if new, or
// patched-in-place if they already exist. The WI license number is
// also added to plant_code_aliases so searching by license number
// resolves the plant.

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { db } = require('../src/db');

const CSV_PATH = process.env.DATCP_CSV_PATH
  || path.join(__dirname, '..', 'data', 'datcp', 'wi-licensed-plants.csv');

function parseStateZip(s) {
  // StateZip is "WI, 53916" or "WI 53916" or just "WI"
  const m = String(s || '').match(/^([A-Z]{2})(?:[,\s]+(\d{5}))?/);
  return m ? { state: m[1], zip: m[2] || null } : { state: null, zip: null };
}

function cleanField(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function derivedCategory(row) {
  // Synthesize a single category label from DATCP's processing fields.
  // Cheese wins when present (most discriminating); fluid/cultured otherwise.
  const txt = [row.GeneralProcessing, row.SpecificProcessing, row.CheeseManufactured]
    .filter(Boolean).join(' ').toLowerCase();
  if (row.CheeseManufactured && row.CheeseManufactured.trim()) return 'cheese';
  if (txt.includes('cream cheese')) return 'cream cheese';
  if (txt.includes('butter')) return 'butter';
  if (txt.includes('ice cream') || txt.includes('frozen')) return 'frozen dessert';
  if (txt.includes('drying') || txt.includes('powder')) return 'dry milk';
  if (txt.includes('whey')) return 'whey';
  if (txt.includes('yogurt') || txt.includes('cultured')) return 'cultured';
  if (txt.includes('pasteurizer') || txt.includes('milk')) return 'fluid milk';
  return null;
}

function parseDatcpText(text) {
  // csv-parse handles the embedded newlines in StreetAddress and the BOM.
  const rows = parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });
  const plants = [];
  let skippedNoCode = 0;
  for (const r of rows) {
    const code = cleanField(r.WIPlantNo);
    if (!code) { skippedNoCode++; continue; }
    const sz = parseStateZip(r.StateZip);
    const name = cleanField(r.BusinessName) || cleanField(r.DBA);
    if (!name) { skippedNoCode++; continue; }
    plants.push({
      plant_code: code,                                    // e.g. "55-117"
      license_no: cleanField(r.LicenseNo) || null,
      name,
      dba: cleanField(r.DBA) || null,
      address: cleanField(r.StreetAddress) || null,
      city: cleanField(r.City) || null,
      state: sz.state || 'WI',
      zip: sz.zip,
      county: cleanField(r.County) || null,
      municipality: cleanField(r.Municipality) || null,
      category: derivedCategory(r),
    });
  }
  return { plants, skippedNoCode };
}

async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`[ingest-datcp] CSV not found at ${CSV_PATH}`);
    process.exit(2);
  }
  const runStarted = new Date().toISOString();
  const text = fs.readFileSync(CSV_PATH, 'utf8');
  const { plants, skippedNoCode } = parseDatcpText(text);
  console.log(`[ingest-datcp] parsed ${plants.length} plants from ${path.basename(CSV_PATH)}`);

  const insertNew = db.prepare(`
    INSERT INTO plants (plant_code, name, address, city, state, category,
                        source, last_verified)
    VALUES (@plant_code, @name, @address, @city, @state, @category,
            'WI-DATCP', date('now'))
  `);

  // Supplement an existing plant: only set fields that are currently empty
  // and DATCP has a value for. NEVER overwrite name, source, or category
  // — IMS data wins on identity, DATCP wins on location detail.
  const supplement = db.prepare(`
    UPDATE plants
       SET address = COALESCE(NULLIF(address, ''), @address),
           city    = COALESCE(NULLIF(city,    ''), @city),
           state   = COALESCE(NULLIF(state,   ''), @state),
           updated_at = datetime('now')
     WHERE plant_code = @plant_code
  `);

  const insertAlias = db.prepare(`
    INSERT INTO plant_code_aliases (plant_id, code, code_system, notes)
    VALUES ((SELECT id FROM plants WHERE plant_code = ?), ?, 'wi-datcp', ?)
    ON CONFLICT(code, code_system) DO UPDATE SET notes = excluded.notes
  `);

  const existsStmt = db.prepare(`SELECT 1 FROM plants WHERE plant_code = ?`);

  let inserted = 0, supplemented = 0;
  const txn = db.transaction(() => {
    for (const p of plants) {
      if (existsStmt.get(p.plant_code)) {
        supplement.run(p);
        supplemented++;
      } else {
        insertNew.run(p);
        inserted++;
      }
      // License number alias so users can search "122850" -> Kraft Beaver Dam.
      if (p.license_no) {
        const notes = [p.dba, p.county, p.municipality].filter(Boolean).join(' / ') || null;
        insertAlias.run(p.plant_code, p.license_no, notes);
      }
    }
  });
  txn();

  db.prepare(`
    INSERT INTO ingest_runs (source, started_at, finished_at, rows_in, rows_written, notes)
    VALUES ('wi-datcp', ?, ?, ?, ?, ?)
  `).run(runStarted, new Date().toISOString(),
    plants.length + skippedNoCode, inserted + supplemented,
    `inserted=${inserted} supplemented=${supplemented} skipped_no_code=${skippedNoCode}`);

  console.log(`[ingest-datcp] inserted=${inserted} supplemented=${supplemented} skipped_no_code=${skippedNoCode}`);
}

module.exports = { parseDatcpText, parseStateZip, derivedCategory };

if (require.main === module) {
  main().catch(err => {
    console.error('[ingest-datcp] failed:', err);
    process.exit(1);
  });
}
