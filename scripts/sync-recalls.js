#!/usr/bin/env node
// Pulls dairy-related recalls from openFDA's food enforcement endpoint,
// stores them in `recalls`, and fuzzy-matches each one to a plant.
//
// Important: openFDA `firm_name` is usually the *recalling firm* (brand
// owner or distributor), not the manufacturing plant. Many recalls
// genuinely cannot be matched to a plant; those are stored with
// match_method='unmatched' and surfaced separately in the UI.

const { db } = require('../src/db');

const BASE = 'https://api.fda.gov/food/enforcement.json';
// Dairy-ish search. Broad on purpose; we filter further by product text.
const SEARCH = '(product_description:milk+OR+product_description:cheese+OR+product_description:yogurt+OR+product_description:cream+OR+product_description:dairy)';
const PAGE_SIZE = 100;
const MAX_PAGES = parseInt(process.env.RECALL_MAX_PAGES || '10', 10);

function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\b(llc|inc|co|corp|corporation|company|cooperative|coop|the|of|usa)\b/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(s) {
  return new Set(normalize(s).split(' ').filter(t => t.length >= 3));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function matchPlant(firmName, firmCity, firmState, plants) {
  const fnTokens = tokenSet(firmName);
  let best = null;
  for (const p of plants) {
    const pTokens = tokenSet(p.name);
    let score = jaccard(fnTokens, pTokens);
    if (!score) continue;
    // Geography bonus: same state +0.2, same city +0.15.
    if (firmState && p.state && firmState.toUpperCase() === p.state.toUpperCase()) score += 0.2;
    if (firmCity && p.city && firmCity.toLowerCase() === p.city.toLowerCase()) score += 0.15;
    if (!best || score > best.score) best = { plant: p, score };
  }
  return best;
}

function fmtDate(d) {
  // openFDA dates come as YYYYMMDD strings.
  if (!d || d.length !== 8) return null;
  return `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;
}

(async () => {
  const runStarted = new Date().toISOString();
  const plants = db.prepare(
    `SELECT id, name, city, state FROM plants`
  ).all();
  console.log(`[recalls] ${plants.length} plants available for matching`);

  const upsertRecall = db.prepare(`
    INSERT INTO recalls (recall_number, firm_name, firm_city, firm_state,
                         plant_id, match_confidence, match_method,
                         reason, classification, status,
                         recall_date, report_date, product_description, raw)
    VALUES (@recall_number, @firm_name, @firm_city, @firm_state,
            @plant_id, @match_confidence, @match_method,
            @reason, @classification, @status,
            @recall_date, @report_date, @product_description, @raw)
    ON CONFLICT(recall_number) DO UPDATE SET
      firm_name=excluded.firm_name,
      firm_city=excluded.firm_city,
      firm_state=excluded.firm_state,
      plant_id=excluded.plant_id,
      match_confidence=excluded.match_confidence,
      match_method=excluded.match_method,
      reason=excluded.reason,
      classification=excluded.classification,
      status=excluded.status,
      recall_date=excluded.recall_date,
      report_date=excluded.report_date,
      product_description=excluded.product_description,
      raw=excluded.raw
  `);

  const applyOverride = db.prepare(`
    UPDATE recalls SET plant_id = (
      SELECT plant_id FROM recall_overrides WHERE recall_number = recalls.recall_number
    ),
    match_method = 'manual',
    match_confidence = 1.0
    WHERE recall_number IN (SELECT recall_number FROM recall_overrides)
  `);

  let totalIn = 0, totalWritten = 0, matched = 0, unmatched = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${BASE}?search=${SEARCH}&limit=${PAGE_SIZE}&skip=${page * PAGE_SIZE}`;
    console.log(`[recalls] GET page ${page + 1} / max ${MAX_PAGES}`);
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      console.error(`[recalls] network error: ${e.message}`);
      break;
    }
    if (res.status === 404) {
      console.log('[recalls] no more results');
      break;
    }
    if (!res.ok) {
      console.error(`[recalls] HTTP ${res.status} ${res.statusText}`);
      break;
    }
    const body = await res.json();
    const results = body.results || [];
    if (!results.length) break;
    totalIn += results.length;

    const writeBatch = db.transaction((rows) => {
      for (const r of rows) {
        const match = matchPlant(r.recalling_firm, r.city, r.state, plants);
        let plant_id = null, match_confidence = null, match_method = 'unmatched';
        if (match && match.score >= 0.35) {
          plant_id = match.plant.id;
          match_confidence = Math.min(1, match.score);
          match_method = match.score >= 0.7 ? 'name+geo' : 'name';
          matched++;
        } else {
          unmatched++;
        }
        upsertRecall.run({
          recall_number: r.recall_number || `unknown-${Math.random().toString(36).slice(2)}`,
          firm_name: r.recalling_firm || null,
          firm_city: r.city || null,
          firm_state: r.state || null,
          plant_id,
          match_confidence,
          match_method,
          reason: r.reason_for_recall || null,
          classification: r.classification || null,
          status: r.status || null,
          recall_date: fmtDate(r.recall_initiation_date),
          report_date: fmtDate(r.report_date),
          product_description: r.product_description || null,
          raw: JSON.stringify(r),
        });
        totalWritten++;
      }
    });
    writeBatch(results);

    if (results.length < PAGE_SIZE) break;
  }

  applyOverride.run();

  db.prepare(`
    INSERT INTO ingest_runs (source, started_at, finished_at, rows_in, rows_written, notes)
    VALUES ('openfda', ?, ?, ?, ?, ?)
  `).run(
    runStarted,
    new Date().toISOString(),
    totalIn,
    totalWritten,
    `matched=${matched} unmatched=${unmatched}`
  );

  console.log(`[recalls] done. in=${totalIn} written=${totalWritten} matched=${matched} unmatched=${unmatched}`);
})().catch(err => {
  console.error('[recalls] failed:', err);
  process.exit(1);
});
