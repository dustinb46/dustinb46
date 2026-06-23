#!/usr/bin/env node
// Ingest the "state-license gap pack" CSV — candidate plants from state
// licensing systems (currently IA, MN, PA) that fill gaps in the federal
// data. The gap pack is human/LLM-curated and ships with review hints
// in two columns we strictly respect:
//
//   Review Status:
//     - 'import_after_dedupe' → load it (with dedupe vs existing plants)
//     - 'do_not_import_yet'   → skip (flagged for human review)
//
//   Existing Atlas Check:
//     - free-text dedupe hint from the curator; we don't auto-act on it
//
// Two code-namespace cases:
//   - IA/MN candidates use state-FIPS codes like "19-0150" / "27-341",
//     same format as IMS and USDA bare-codes. We normalize zero-padding
//     so "19-0150" matches an existing "19-150" alias.
//   - PA candidates use long opaque license numbers (e.g. "10002193"),
//     which we prefix as "PA-LIC-10002193" to avoid colliding with
//     unrelated codes from other systems.

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { db } = require('../src/db');

const CSV_PATH = process.env.GAP_CSV_PATH
  || path.join(__dirname, '..', 'data', 'state-gap', 'import-candidates.csv');

function normCode(code) {
  // Strip zero-padding from each numeric segment so "19-0150" == "19-150".
  // Only meaningful for the NN-XXX shape; passes other formats through.
  const m = String(code || '').match(/^(\d{1,3})-(\d{1,5})$/);
  return m ? `${parseInt(m[1], 10)}-${parseInt(m[2], 10)}` : null;
}

function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

function pickPlantCode(row) {
  const raw = clean(row['Plant Code / License ID']);
  const state = clean(row.State);
  if (!raw) return null;
  // FIPS-state-prefixed codes (IA, MN, ...) we keep as-is so they
  // naturally collide with IMS/USDA bare codes for the same plant.
  if (/^\d{1,3}-\d{1,5}$/.test(raw)) return raw;
  // PA-style opaque license numbers — namespace to avoid collisions.
  return `${state}-LIC-${raw}`;
}

function categoryFromHint(row) {
  const t = (clean(row['Product Hint']) + ' ' + clean(row['License / Permit Type'])).toLowerCase();
  if (t.includes('cheese')) return 'cheese';
  if (t.includes('butter')) return 'butter';
  if (t.includes('ice cream') || t.includes('frozen')) return 'frozen dessert';
  if (t.includes('yogurt') || t.includes('cultured')) return 'cultured';
  if (t.includes('whey') || t.includes('dry') || t.includes('powder')) return 'dry/whey';
  if (t.includes('grade a') || t.includes('fluid') || t.includes('manufacturing')) return null; // too generic
  return null;
}

async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`[gap-ingest] CSV not found at ${CSV_PATH}`);
    process.exit(2);
  }
  const runStarted = new Date().toISOString();
  const text = fs.readFileSync(CSV_PATH, 'utf8');
  const rows = parse(text, { columns: true, skip_empty_lines: true, trim: true, bom: true });

  // Build a lookup of every existing plant by normalized code (from both
  // plants.plant_code and plant_code_aliases). Same union the recall
  // harvester uses, so we never duplicate a plant we already have via
  // IMS, USDA, or DATCP.
  const byNorm = new Map();
  for (const p of db.prepare(`SELECT id, plant_code FROM plants`).all()) {
    const k = normCode(p.plant_code);
    if (k && !byNorm.has(k)) byNorm.set(k, p);
  }
  for (const a of db.prepare(`
    SELECT p.id, p.plant_code, a.code FROM plant_code_aliases a
    JOIN plants p ON p.id = a.plant_id
  `).all()) {
    const k = normCode(a.code);
    if (k && !byNorm.has(k)) byNorm.set(k, { id: a.id, plant_code: a.plant_code });
  }

  const insertNew = db.prepare(`
    INSERT INTO plants (plant_code, name, address, city, state, category,
                        source, last_verified)
    VALUES (@plant_code, @name, @address, @city, @state, @category,
            'state-gap', date('now'))
  `);
  const supplement = db.prepare(`
    UPDATE plants
       SET address = COALESCE(NULLIF(address, ''), @address),
           city    = COALESCE(NULLIF(city,    ''), @city),
           state   = COALESCE(NULLIF(state,   ''), @state),
           updated_at = datetime('now')
     WHERE id = @id
  `);
  const insertAlias = db.prepare(`
    INSERT INTO plant_code_aliases (plant_id, code, code_system, notes)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(code, code_system) DO UPDATE SET notes = excluded.notes
  `);

  let inserted = 0, supplemented = 0, skippedHold = 0, skippedNoCode = 0;
  const byStateCounts = {};

  const txn = db.transaction(() => {
    for (const r of rows) {
      const status = clean(r['Review Status']);
      if (status !== 'import_after_dedupe') { skippedHold++; continue; }
      const code = pickPlantCode(r);
      if (!code) { skippedNoCode++; continue; }
      const name = clean(r['Company / Licensee']) || clean(r['Site Name']);
      if (!name) { skippedNoCode++; continue; }

      const st = clean(r.State);
      byStateCounts[st] = (byStateCounts[st] || 0) + 1;

      const aliasSystem = `state-gap-${st.toLowerCase()}`;
      const aliasNote = [clean(r['License / Permit Type']), clean(r['Source System'])]
        .filter(Boolean).join(' / ');

      const key = normCode(code);
      const existing = key ? byNorm.get(key) : null;

      if (existing) {
        supplement.run({
          id: existing.id,
          address: clean(r.Address) || null,
          city: clean(r.City) || null,
          state: st || null,
        });
        insertAlias.run(existing.id, code, aliasSystem, aliasNote || null);
        supplemented++;
      } else {
        insertNew.run({
          plant_code: code,
          name,
          address: clean(r.Address) || null,
          city: clean(r.City) || null,
          state: st || null,
          category: categoryFromHint(r),
        });
        const newId = db.prepare(`SELECT id FROM plants WHERE plant_code = ?`).get(code).id;
        insertAlias.run(newId, code, aliasSystem, aliasNote || null);
        // Add the normalized form too so future ingests dedup correctly.
        if (key && key !== code) insertAlias.run(newId, key, aliasSystem, 'normalized form');
        inserted++;
      }
    }
  });
  txn();

  db.prepare(`
    INSERT INTO ingest_runs (source, started_at, finished_at, rows_in, rows_written, notes)
    VALUES ('state-gap', ?, ?, ?, ?, ?)
  `).run(runStarted, new Date().toISOString(), rows.length, inserted + supplemented,
    `inserted=${inserted} supplemented=${supplemented} held=${skippedHold} no_code=${skippedNoCode} by_state=${JSON.stringify(byStateCounts)}`);

  console.log(`[gap-ingest] rows=${rows.length} inserted=${inserted} supplemented=${supplemented} held=${skippedHold} no_code=${skippedNoCode}`);
  console.log('[gap-ingest] by state (loaded):', JSON.stringify(byStateCounts));
}

module.exports = { normCode, pickPlantCode, categoryFromHint };

if (require.main === module) {
  main().catch(err => { console.error('[gap-ingest] failed:', err); process.exit(1); });
}
