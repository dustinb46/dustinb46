#!/usr/bin/env node
// Geocodes plants to lat/lon city centroids.
//
// Primary: OpenStreetMap Nominatim. Free, no API key, supports city-only
// queries. Strict rate limit: 1 req/sec and an honest User-Agent are
// required by their Acceptable Use Policy, so we throttle accordingly.
//
// Fallback: US Census Geocoder with a synthetic "1 Main St, city, state"
// query — Census doesn't return city centroids for city-only requests, so
// we trick it. Used only if Nominatim returns nothing.
//
// City-level cache: many plants share a city. We geocode each city once
// per run and reuse, which cuts a 2400-plant run from 40+ minutes to
// roughly 800-1000 unique city lookups.

const { db } = require('../src/db');

const SLEEP_MS = parseInt(process.env.GEOCODE_SLEEP_MS || '1100', 10);  // Nominatim wants >=1s
const MAX = parseInt(process.env.GEOCODE_MAX || '5000', 10);
const FORCE = process.env.FORCE === '1';
const USER_AGENT = 'DairyPlantAtlas/1.0 (contact: brunndairy88@gmail.com)';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const CENSUS_URL = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function geocodeNominatim(city, state) {
  const q = `${city}, ${state}, USA`;
  const url = `${NOMINATIM_URL}?q=${encodeURIComponent(q)}&format=json&limit=1&countrycodes=us`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`nominatim HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body) || !body.length) return null;
  return { lat: parseFloat(body[0].lat), lon: parseFloat(body[0].lon), source: 'osm' };
}

async function geocodeCensus(city, state) {
  // Census wants a street address; pass a synthetic one. The address
  // won't match but the geocoder still returns the city's coordinates
  // for the closest match it finds.
  const q = encodeURIComponent(`1 Main St, ${city}, ${state}`);
  const url = `${CENSUS_URL}?address=${q}&benchmark=Public_AR_Current&format=json`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`census HTTP ${res.status}`);
  const body = await res.json();
  const matches = body?.result?.addressMatches || [];
  if (!matches.length) return null;
  const c = matches[0].coordinates;
  return { lat: parseFloat(c.y), lon: parseFloat(c.x), source: 'census' };
}

const cityCache = new Map();
async function cachedGeocode(city, state) {
  const key = `${city.toUpperCase()}|${state.toUpperCase()}`;
  if (cityCache.has(key)) return cityCache.get(key);
  let result = null;
  try { result = await geocodeNominatim(city, state); }
  catch (e) { /* try fallback */ }
  if (!result) {
    try { result = await geocodeCensus(city, state); }
    catch (e) { /* both failed */ }
  }
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
  console.log(`[geocode] ${rows.length} plants to geocode${FORCE ? ' (FORCE)' : ''}; ~${SLEEP_MS}ms per unique city`);

  const update = db.prepare(`
    UPDATE plants SET lat = ?, lon = ?, geocoded_at = datetime('now') WHERE id = ?
  `);

  let ok = 0, miss = 0, err = 0, sourceCounts = { osm: 0, census: 0 };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const cached = cityCache.has(`${r.city.toUpperCase()}|${r.state.toUpperCase()}`);
    try {
      const hit = await cachedGeocode(r.city, r.state);
      if (hit) {
        update.run(hit.lat, hit.lon, r.id);
        ok++;
        if (hit.source) sourceCounts[hit.source]++;
      } else {
        miss++;
      }
    } catch (e) {
      err++;
      if (err <= 5) console.error(`  err ${r.plant_code} (${r.city}, ${r.state}): ${e.message}`);
    }
    if ((i + 1) % 100 === 0) {
      console.log(`  ${i + 1}/${rows.length}  ok=${ok} miss=${miss} err=${err}  cities cached=${cityCache.size}  (osm=${sourceCounts.osm} census=${sourceCounts.census})`);
    }
    // Only throttle on a real network call; cache hits go through immediately.
    if (!cached) await sleep(SLEEP_MS);
  }

  db.prepare(`
    INSERT INTO ingest_runs (source, started_at, finished_at, rows_in, rows_written, notes)
    VALUES ('geocode', ?, ?, ?, ?, ?)
  `).run(runStarted, new Date().toISOString(), rows.length, ok,
    `miss=${miss} err=${err} cities=${cityCache.size} osm=${sourceCounts.osm} census=${sourceCounts.census}`);

  console.log(`[geocode] done. ok=${ok} miss=${miss} err=${err} (${cityCache.size} unique cities; osm=${sourceCounts.osm} census=${sourceCounts.census})`);
})().catch(e => { console.error(e); process.exit(1); });

