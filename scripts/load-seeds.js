#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { db } = require('../src/db');

const SEED_DIR = path.join(__dirname, '..', 'data', 'seeds');

function readCsv(name) {
  const file = path.join(SEED_DIR, name);
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  return parse(text, { columns: true, skip_empty_lines: true, trim: true });
}

const runStarted = new Date().toISOString();
let plantsIn = 0, plantsWritten = 0;
let brandsIn = 0, brandsWritten = 0;
let mappingsIn = 0, mappingsWritten = 0;

const upsertPlant = db.prepare(`
  INSERT INTO plants (plant_code, name, address, city, state, category,
                      parent_company, fmmo_pool, ims_rating, source, last_verified)
  VALUES (@plant_code, @name, @address, @city, @state, @category,
          @parent_company, @fmmo_pool, @ims_rating, @source, @last_verified)
  ON CONFLICT(plant_code) DO UPDATE SET
    name=excluded.name,
    address=excluded.address,
    city=excluded.city,
    state=excluded.state,
    category=excluded.category,
    parent_company=excluded.parent_company,
    fmmo_pool=excluded.fmmo_pool,
    ims_rating=excluded.ims_rating,
    source=excluded.source,
    last_verified=excluded.last_verified,
    updated_at=datetime('now')
`);

const upsertBrand = db.prepare(`
  INSERT INTO brands (brand_name, brand_type, parent_company)
  VALUES (@brand_name, @brand_type, @parent_company)
  ON CONFLICT(brand_name) DO UPDATE SET
    brand_type=excluded.brand_type,
    parent_company=excluded.parent_company
`);

const findPlantByCode = db.prepare(`SELECT id FROM plants WHERE plant_code = ?`);
const findBrandByName = db.prepare(`SELECT id FROM brands WHERE brand_name = ?`);
const insertBrandShallow = db.prepare(
  `INSERT INTO brands (brand_name) VALUES (?) ON CONFLICT(brand_name) DO NOTHING`
);

const findMapping = db.prepare(`
  SELECT id FROM plant_brands
  WHERE plant_id = ? AND brand_id = ? AND IFNULL(region,'') = IFNULL(?, '')
`);
const updateMapping = db.prepare(`
  UPDATE plant_brands SET
    product_category = @product_category,
    source = @source,
    confidence = @confidence,
    notes = @notes,
    last_verified = @last_verified,
    verified_by = @verified_by
  WHERE id = @id
`);
const insertMapping = db.prepare(`
  INSERT INTO plant_brands (plant_id, brand_id, product_category, region,
                            source, confidence, notes, last_verified, verified_by)
  VALUES (@plant_id, @brand_id, @product_category, @region,
          @source, @confidence, @notes, @last_verified, @verified_by)
`);

const load = db.transaction(() => {
  // Once real IMS data exists, the illustrative placeholders must not
  // come back — prestart re-runs this loader on every container start.
  // Skip loading them and retire any that are already in the DB
  // (plant deletion cascades to their plant_brands rows).
  const hasRealPlants = db.prepare(
    `SELECT COUNT(*) AS n FROM plants WHERE source = 'IMS'`
  ).get().n > 0;

  if (hasRealPlants) {
    const gonePlants = db.prepare(
      `DELETE FROM plants WHERE source = 'illustrative_seed'`
    ).run().changes;
    const goneBrands = db.prepare(
      `DELETE FROM brands WHERE brand_name LIKE 'EXAMPLE%'
       AND id NOT IN (SELECT brand_id FROM plant_brands)`
    ).run().changes;
    if (gonePlants || goneBrands) {
      console.log(`[load-seeds] real IMS data present: retired ${gonePlants} placeholder plants, ${goneBrands} placeholder brands`);
    }
  }

  // Reconcile manually-seeded plants too: if a row was removed from
  // plants.csv it should drop from the DB. Same policy as the
  // illustrative rows, scoped to source='manual' so we never touch
  // federally-sourced data. Runs before the upsert loop so we don't
  // delete a row we're about to re-insert.
  const csvManualCodes = new Set(
    readCsv('plants.csv')
      .filter(r => (r.source || '') === 'manual' && r.plant_code)
      .map(r => r.plant_code)
  );
  const existingManual = db.prepare(
    `SELECT plant_code FROM plants WHERE source = 'manual'`
  ).all();
  let goneManual = 0;
  const delManual = db.prepare(
    `DELETE FROM plants WHERE plant_code = ? AND source = 'manual'`
  );
  for (const row of existingManual) {
    if (!csvManualCodes.has(row.plant_code)) {
      delManual.run(row.plant_code);
      goneManual++;
    }
  }
  if (goneManual) console.log(`[load-seeds] retired ${goneManual} manual plant(s) no longer in plants.csv`);

  for (const row of readCsv('plants.csv')) {
    plantsIn++;
    if (hasRealPlants && row.source === 'illustrative_seed') continue;
    upsertPlant.run({
      plant_code: row.plant_code,
      name: row.name,
      address: row.address || null,
      city: row.city || null,
      state: row.state || null,
      category: row.category || null,
      parent_company: row.parent_company || null,
      fmmo_pool: row.fmmo_pool || null,
      ims_rating: row.ims_rating || null,
      source: row.source || 'seed',
      last_verified: row.last_verified || null,
    });
    plantsWritten++;
  }

  for (const row of readCsv('brands.csv')) {
    brandsIn++;
    if (hasRealPlants && row.brand_name.startsWith('EXAMPLE')) continue;
    upsertBrand.run({
      brand_name: row.brand_name,
      brand_type: row.brand_type || null,
      parent_company: row.parent_company || null,
    });
    brandsWritten++;
  }

  const skipped = [];
  for (const row of readCsv('plant_brands.csv')) {
    mappingsIn++;
    if (hasRealPlants && row.source === 'illustrative_seed') continue;
    const plant = findPlantByCode.get(row.plant_code);
    if (!plant) {
      skipped.push(`plant_code ${row.plant_code} not found for brand ${row.brand_name}`);
      continue;
    }
    if (!row.confidence || !['high', 'medium', 'low'].includes(row.confidence)) {
      skipped.push(`confidence missing/invalid for ${row.plant_code} -> ${row.brand_name}`);
      continue;
    }
    if (!row.source) {
      skipped.push(`source missing for ${row.plant_code} -> ${row.brand_name}`);
      continue;
    }
    insertBrandShallow.run(row.brand_name);
    const brand = findBrandByName.get(row.brand_name);
    const region = row.region || null;
    const existing = findMapping.get(plant.id, brand.id, region);
    const payload = {
      plant_id: plant.id,
      brand_id: brand.id,
      product_category: row.product_category || null,
      region,
      source: row.source,
      confidence: row.confidence,
      notes: row.notes || null,
      last_verified: row.last_verified || null,
      verified_by: row.verified_by || null,
    };
    if (existing) {
      updateMapping.run({ ...payload, id: existing.id });
    } else {
      insertMapping.run(payload);
    }
    mappingsWritten++;
  }

  if (skipped.length) {
    console.warn(`[load-seeds] skipped ${skipped.length} mapping rows:`);
    for (const s of skipped) console.warn(`  - ${s}`);
  }
});

load();

// Parent-company aliasing: many plants are listed in IMS/USDA under the
// pre-acquisition operating name (e.g. ST. ALBANS CREAMERY is really
// DFA since 2019). We map those by name pattern and fill parent_company
// when it's empty, so searching "DFA" or filtering by parent surfaces
// the acquired operations too. We never overwrite an existing
// parent_company value — those come from authoritative seeds or the
// federal ingests.
let aliasesApplied = 0, aliasRulesApplied = 0;
const aliasRows = readCsv('parent_aliases.csv');
// Longest patterns first so a specific match (LACTALIS HERITAGE) wins
// over a broader one (LACTALIS) on the same plant.
aliasRows.sort((a, b) => (b.pattern || '').length - (a.pattern || '').length);
const aliasUpdateContains = db.prepare(`
  UPDATE plants SET parent_company = ?
  WHERE (parent_company IS NULL OR parent_company = '')
    AND UPPER(name) LIKE ?
`);
const aliasTxn = db.transaction(() => {
  for (const a of aliasRows) {
    if (!a.parent_company || !a.pattern) continue;
    if (a.match_type === 'name_contains') {
      const info = aliasUpdateContains.run(
        a.parent_company, '%' + a.pattern.toUpperCase() + '%'
      );
      if (info.changes) {
        aliasesApplied += info.changes;
        aliasRulesApplied++;
      }
    }
  }
});
aliasTxn();
if (aliasesApplied) {
  console.log(`[load-seeds] parent_company set on ${aliasesApplied} plants via ${aliasRulesApplied} alias rule(s)`);
}

// News items: upsert by stable fingerprint (sha1 of event_date + headline)
// so re-runs are idempotent. Plant resolution by plant_code where the
// CSV supplies one; unresolved is fine — the item still renders with
// firm name and location, just without the plant link.
const crypto = require('crypto');
let newsIn = 0, newsWritten = 0, newsSkipped = 0;
const newsRows = readCsv('news_items.csv');
const findPlantIdByCode = db.prepare(`SELECT id FROM plants WHERE plant_code = ?`);
const upsertNews = db.prepare(`
  INSERT INTO news_items (event_date, kind, headline, body, plant_id, plant_code,
                          firm_name, city, state, source_url, source_name,
                          added_by, fingerprint)
  VALUES (@event_date, @kind, @headline, @body, @plant_id, @plant_code,
          @firm_name, @city, @state, @source_url, @source_name,
          @added_by, @fingerprint)
  ON CONFLICT(fingerprint) DO UPDATE SET
    event_date = excluded.event_date,
    kind = excluded.kind,
    headline = excluded.headline,
    body = excluded.body,
    plant_id = excluded.plant_id,
    plant_code = excluded.plant_code,
    firm_name = excluded.firm_name,
    city = excluded.city,
    state = excluded.state,
    source_url = excluded.source_url,
    source_name = excluded.source_name,
    added_by = excluded.added_by
`);
const ALLOWED_KINDS = new Set([
  'closure', 'opening', 'sale', 'expansion', 'acquisition',
  'leadership', 'investment', 'other',
]);
const newsTxn = db.transaction(() => {
  for (const row of newsRows) {
    newsIn++;
    if (!row.event_date || !row.headline) { newsSkipped++; continue; }
    if (!row.source_url)                  { newsSkipped++; continue; }   // every item needs a source
    if (!ALLOWED_KINDS.has(row.kind))     { newsSkipped++; continue; }
    const plantHit = row.plant_code ? findPlantIdByCode.get(row.plant_code) : null;
    const fingerprint = crypto.createHash('sha1')
      .update(row.event_date + '|' + row.headline).digest('hex').slice(0, 16);
    upsertNews.run({
      event_date: row.event_date,
      kind: row.kind,
      headline: row.headline,
      body: row.body || null,
      plant_id: plantHit ? plantHit.id : null,
      plant_code: row.plant_code || null,
      firm_name: row.firm_name || null,
      city: row.city || null,
      state: row.state || null,
      source_url: row.source_url,
      source_name: row.source_name || null,
      added_by: row.added_by || 'seed',
      fingerprint,
    });
    newsWritten++;
  }
});
newsTxn();
if (newsIn) {
  console.log(`[load-seeds] news_items ${newsWritten}/${newsIn} (skipped ${newsSkipped})`);
}

db.prepare(`
  INSERT INTO ingest_runs (source, started_at, finished_at, rows_in, rows_written, notes)
  VALUES ('seeds', ?, ?, ?, ?, ?)
`).run(
  runStarted,
  new Date().toISOString(),
  plantsIn + brandsIn + mappingsIn,
  plantsWritten + brandsWritten + mappingsWritten,
  `plants=${plantsWritten}/${plantsIn} brands=${brandsWritten}/${brandsIn} mappings=${mappingsWritten}/${mappingsIn} alias-plants=${aliasesApplied}`
);

console.log(`[load-seeds] plants ${plantsWritten}/${plantsIn}, brands ${brandsWritten}/${brandsIn}, mappings ${mappingsWritten}/${mappingsIn}`);
