#!/usr/bin/env node
// Harvest plant codes from stored recall records.
//
// Recall notices frequently embed the manufacturing plant code in their
// code_info ("plant code: PLT19-145, code date DEC08...") — public,
// FDA-documented evidence of who actually made the recalled product.
// This scans the raw openFDA JSON we already store, extracts candidate
// plant codes, and cross-references them against the IMS plants table.
//
// Report-only by default. With APPLY=1, recalls whose extracted code
// resolves to exactly one IMS plant get plant_id set with
// match_method='plt_code' (stronger evidence than fuzzy name matching).
//
// It never writes brand mappings — emit candidates, human curates.

const { db } = require('../src/db');

const APPLY = process.env.APPLY === '1';

// Conservative extraction: require PLT prefix or explicit "plant" context
// so we don't harvest dates, UPC fragments, or lot numbers.
const CODE_PATTERNS = [
  /\bPLT\s*#?\s*(\d{1,3})\s*-\s*(\d{1,5})\b/gi,
  /\bplant\s*(?:code|number|no\.?|#)?\s*:?\s*(\d{1,3})\s*-\s*(\d{1,5})\b/gi,
];

function extractCodes(text) {
  const found = new Set();
  if (!text) return found;
  for (const re of CODE_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      found.add(`${m[1]}-${m[2]}`);
    }
  }
  return found;
}

// Normalize "01-0326" and "1-326" to the same key so padding differences
// between recall notices and the IMS list don't block resolution.
function normCode(code) {
  const m = code.match(/^(\d{1,3})-(\d{1,5})$/);
  if (!m) return null;
  return `${parseInt(m[1], 10)}-${parseInt(m[2], 10)}`;
}

// Build normalized lookup of IMS plants. Skip ambiguous keys (two plants
// whose codes differ only in zero-padding) rather than guess.
const plantsByNorm = new Map();
const ambiguous = new Set();
for (const p of db.prepare(`SELECT id, plant_code, name, city, state FROM plants`).all()) {
  const key = normCode(p.plant_code);
  if (!key) continue;
  if (plantsByNorm.has(key) && plantsByNorm.get(key).plant_code !== p.plant_code) {
    ambiguous.add(key);
    continue;
  }
  plantsByNorm.set(key, p);
}

const recalls = db.prepare(`
  SELECT id, recall_number, firm_name, firm_city, firm_state,
         product_description, plant_id, match_method, raw
  FROM recalls
`).all();

let withCodes = 0, resolved = 0, unresolved = 0, applied = 0;
const resolvedRows = [];
const unresolvedRows = [];

const setPlant = db.prepare(`
  UPDATE recalls SET plant_id = ?, match_confidence = 0.95, match_method = 'plt_code'
  WHERE id = ?
`);

for (const r of recalls) {
  let raw = {};
  try { raw = JSON.parse(r.raw || '{}'); } catch { /* keep {} */ }
  const haystack = [raw.code_info, raw.more_code_info, r.product_description]
    .filter(Boolean).join(' || ');
  const codes = extractCodes(haystack);
  if (!codes.size) continue;
  withCodes++;

  for (const code of codes) {
    const key = normCode(code);
    const hit = key && !ambiguous.has(key) ? plantsByNorm.get(key) : null;
    if (hit) {
      resolved++;
      resolvedRows.push({ recall: r, code, plant: hit });
      if (APPLY && r.match_method !== 'manual') {
        setPlant.run(hit.id, r.id);
        applied++;
      }
    } else {
      unresolved++;
      unresolvedRows.push({ recall: r, code });
    }
  }
}

console.log(`[harvest] recalls scanned: ${recalls.length}`);
console.log(`[harvest] recalls with embedded plant codes: ${withCodes}`);
console.log(`[harvest] codes resolved to IMS plants: ${resolved}`);
console.log(`[harvest] codes not in IMS table: ${unresolved}`);
if (APPLY) console.log(`[harvest] recalls updated with plt_code match: ${applied}`);
else console.log('[harvest] report-only (set APPLY=1 / ?apply=1 to update recall matches)');

console.log('\n=== RESOLVED (candidate brand mappings — curate before committing) ===');
for (const { recall, code, plant } of resolvedRows.slice(0, 60)) {
  console.log(`\n  recall ${recall.recall_number}  code ${code} -> ${plant.plant_code}`);
  console.log(`    plant: ${plant.name} (${plant.city}, ${plant.state})`);
  console.log(`    firm:  ${recall.firm_name || '?'} (${recall.firm_city || '?'}, ${recall.firm_state || '?'})`);
  console.log(`    product: ${(recall.product_description || '').slice(0, 140)}`);
}

console.log('\n=== UNRESOLVED CODES (not in IMS table — maybe non-Grade-A or parser gap) ===');
const byCode = new Map();
for (const { recall, code } of unresolvedRows) {
  if (!byCode.has(code)) byCode.set(code, []);
  byCode.get(code).push(recall);
}
let shown = 0;
for (const [code, rs] of byCode) {
  if (shown++ >= 30) break;
  console.log(`  ${code.padEnd(10)} x${rs.length}  e.g. ${rs[0].firm_name || '?'} — ${(rs[0].product_description || '').slice(0, 80)}`);
}
