#!/usr/bin/env node
// Suggest brand -> plant mappings by matching the brand name against
// plant operator names. This is a candidate generator, NOT an
// auto-linker: a name match alone isn't proof (e.g. the "Daisy" sour
// cream brand vs a "Daisy Farms" milk BTU), so output is for human
// review. It prints ready-to-paste plant_brands.csv rows so accepting a
// suggestion is a copy, not a research project.
//
// Deliberately conservative: only the brand-name-in-plant-name signal,
// which is the lowest-noise case. Parent-company matching (e.g. Cabot ->
// every Agri-Mark plant) is noisier and left out on purpose.

const { db } = require('../src/db');
const { normalizeName, operatorToken } = require('../src/facility');

function tokenSet(s) { return new Set(normalizeName(s).split(/\s+/).filter(Boolean)); }

const brands = db.prepare(`SELECT id, brand_name, parent_company FROM brands`).all();
const plants = db.prepare(`SELECT id, plant_code, name, city, state FROM plants`).all();

// Existing mappings, so we don't re-suggest what's already curated.
const existing = new Set(
  db.prepare(`
    SELECT b.brand_name || '|' || p.plant_code AS k
    FROM plant_brands pb
    JOIN brands b ON b.id = pb.brand_id
    JOIN plants p ON p.id = pb.plant_id
  `).all().map(r => r.k)
);

// Precompute plant tokens once.
const plantInfo = plants.map(p => ({
  ...p,
  tokens: tokenSet(p.name),
  op: operatorToken(p.name),
}));

function scoreMatch(brandTokens, brandOp, plant) {
  if (!brandTokens.size || !brandOp) return 0;
  // All brand tokens present in the plant name?
  let covered = 0;
  for (const t of brandTokens) if (plant.tokens.has(t)) covered++;
  const coverage = covered / brandTokens.size;
  if (coverage < 1) {
    // Partial: only interesting if the distinctive operator token matches.
    return plant.op === brandOp ? 0.5 : 0;
  }
  // Full coverage. Exact operator match is the strongest signal.
  if (plant.op === brandOp && plant.tokens.size === brandTokens.size) return 0.9; // names essentially equal
  if (plant.op === brandOp) return 0.8;
  return 0.65;
}

// Name-match candidates never earn "high" — that's reserved for documented
// or recall-printed evidence. Suggest medium/low for the reviewer.
function suggestedConfidence(score) {
  return score >= 0.8 ? 'medium' : 'low';
}

let total = 0;
const today = new Date().toISOString().slice(0, 10);

for (const brand of brands) {
  const brandTokens = tokenSet(brand.brand_name);
  const brandOp = operatorToken(brand.brand_name);
  const hits = [];
  for (const p of plantInfo) {
    if (existing.has(`${brand.brand_name}|${p.plant_code}`)) continue;
    const score = scoreMatch(brandTokens, brandOp, p);
    if (score >= 0.65) hits.push({ p, score });
  }
  if (!hits.length) continue;
  hits.sort((a, b) => b.score - a.score);

  console.log(`\n## ${brand.brand_name}  (${hits.length} candidate${hits.length > 1 ? 's' : ''})`);
  for (const { p, score } of hits) {
    total++;
    const conf = suggestedConfidence(score);
    console.log(`  [${score.toFixed(2)} -> ${conf}] ${p.plant_code.padEnd(11)} ${p.name} (${p.city || '?'}, ${p.state || '?'})`);
    // Ready-to-paste plant_brands.csv row.
    console.log(`    csv: ${p.plant_code},${brand.brand_name},,,name-match (review),${conf},Auto-suggested by name match; verify before trusting,${today},auto`);
  }
}

console.log(`\n[match-brands] ${total} candidate mapping(s) across ${brands.length} brands.`);
console.log('[match-brands] Review each, then paste the good csv: lines into data/seeds/plant_brands.csv.');
console.log('[match-brands] Name match alone is a lead, not proof — confirm co-pack/private-label by another source.');
