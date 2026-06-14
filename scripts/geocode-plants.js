#!/usr/bin/env node
// Geocodes plants to lat/lon city centroids using the US Census Geocoder.
// Free, no API key, no per-second rate limit (we throttle ourselves to be
// polite). Only operates on rows that don't already have coordinates so
// re-runs are cheap.
//
// We geocode at city+state granularity because that's all the IMS and
// USDA lists give us. Pin accuracy is "the right town", not "the building".
// That's plenty for an at-a-glance national density map.

const { db } = require('../src/db');

const SLEEP_MS = parseInt(process.env.GEOCODE_SLEEP_MS || '120', 10);
const MAX = parseInt(process.env.GEOCODE_MAX || '5000', 10);
const FORCE = process.env.FORCE === '1';

const GEOCODE_URL = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function geocodeCityState(city, state) {
  // Census wants an address-y string. City+state alone works for a
  // centroid match; sending a placeholder street name keeps the API
  // happy and Census just falls back to the city center.
  const q = encodeURIComponent(`${city}, ${state}`);
  const url = `${GEOCODE_URL}?address=${q}&benchmark=Public_AR_Current&format=json`;
  const res = await fetch(url, { headers: { 'User-Agent': 'DairyPlantAtlas/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const matches = body?.result?.addressMatches || [];
  if (!matches.length) return null;
  const c = matches[0].coordinates;
  return { lat: parseFloat(c.y), lon: parseFloat(c.x) };
}

// City-level cache: many plants share a city (Tulare CA has 6+ plants,
// Logan UT has 3, etc.). Geocode each city once per run.
const cityCache = new Map();
async function cachedGeocode(city, state) {
  const key = `${city.toUpperCase()}|${state.toUpperCase()}`;
  if (cityCache.has(key)) return cityCache.get(key);
  const result = await geocodeCityState(city, state);
  cityCache.set(key, result);
  return result;
}

(async () => {
  const runStarted = new Date().toISOString();
  const where = FORCE ? '' : ' AND (lat IS NULL OR lon IS NULL)';
  const rows = db.prepare(`
    SELECT id, plant_code, city, state FROM plants
    WHERE city IS NOT NULL AND state IS NOT NULL${where}
    LIMIT ${MAX}
  `).all();
  console.log(`[geocode] ${rows.length} plants to geocode${FORCE ? ' (FORCE)' : ''}`);

  const update = db.prepare(`
    UPDATE plants SET lat = ?, lon = ?, geocoded_at = datetime('now')
    WHERE id = ?
  `);

  let ok = 0, miss = 0, err = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      const hit = await cachedGeocode(r.city, r.state);
      if (hit) { update.run(hit.lat, hit.lon, r.id); ok++; }
      else     { miss++; }
    } catch (e) {
      err++;
      if (err <= 5) console.error(`  err ${r.plant_code}: ${e.message}`);
    }
    if ((i + 1) % 100 === 0) console.log(`  ${i + 1}/${rows.length}  ok=${ok} miss=${miss} err=${err}  cities cached=${cityCache.size}`);
    await sleep(SLEEP_MS);
  }

  db.prepare(`
    INSERT INTO ingest_runs (source, started_at, finished_at, rows_in, rows_written, notes)
    VALUES ('geocode', ?, ?, ?, ?, ?)
  `).run(runStarted, new Date().toISOString(), rows.length, ok,
    `miss=${miss} err=${err} cities=${cityCache.size}`);

  console.log(`[geocode] done. ok=${ok} miss=${miss} err=${err} (${cityCache.size} unique cities)`);
})().catch(e => { console.error(e); process.exit(1); });
