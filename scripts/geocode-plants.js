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

const fs = require('fs');
const { parse } = require('csv-parse/sync');
const { db } = require('../src/db');
const { isOutsideState } = require('../src/us-state-bounds');

const SLEEP_MS = parseInt(process.env.GEOCODE_SLEEP_MS || '1100', 10);  // Nominatim wants >=1s
const MAX = parseInt(process.env.GEOCODE_MAX || '5000', 10);
const FORCE = process.env.FORCE === '1';
const USER_AGENT = 'DairyPlantAtlas/1.0 (contact: brunndairy88@gmail.com)';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const CENSUS_URL = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Nominatim enforces its 1 req/sec policy hard, and enforces it per source
// IP — behind a shared or proxied egress address it starts returning 429
// well before our own pacing looks abusive. A 429 is a "come back later",
// not "this city does not exist", so it gets retried with backoff and, if
// it still fails, reported as an error rather than a miss. Conflating the
// two is what previously left the map half empty with err=0 in the log.
const RETRIES = parseInt(process.env.GEOCODE_RETRIES || '4', 10);

class RateLimited extends Error {}

async function nominatimOnce(q) {
  const url = `${NOMINATIM_URL}?q=${encodeURIComponent(q)}&format=json&limit=1&countrycodes=us`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' } });
  if (res.status === 429 || res.status === 503) {
    const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
    throw Object.assign(new RateLimited(`nominatim HTTP ${res.status}`), { retryAfter });
  }
  if (!res.ok) throw new Error(`nominatim HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body) || !body.length) return null;   // genuinely no match
  return body[0];
}

async function geocodeNominatim(city, state, address) {
  // Build the most specific query we have: street address when available,
  // otherwise city-level. Street-level returns a building-precise pin
  // (good for WI DATCP plants that ship with addresses); city-level
  // returns a town centroid (the existing behavior).
  const q = address
    ? `${address}, ${city}, ${state}, USA`
    : `${city}, ${state}, USA`;

  let wait = SLEEP_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      const hit = await nominatimOnce(q);
      if (!hit) return null;
      return { lat: parseFloat(hit.lat), lon: parseFloat(hit.lon), source: address ? 'osm-street' : 'osm' };
    } catch (e) {
      if (!(e instanceof RateLimited) || attempt >= RETRIES) throw e;
      // Honour Retry-After when offered, otherwise back off exponentially.
      const delay = e.retryAfter ? e.retryAfter * 1000 : wait;
      rateLimitHits++;
      await sleep(delay);
      wait = Math.min(wait * 2, 30000);
    }
  }
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

// City-level cache only — street-level lookups are unique per plant so
// they're not cacheable, but they're a small fraction of the workload
// and worth the precision.
//
// Only *negative results* are cached, never *failures*. A city that
// Nominatim genuinely has no record of will not appear on a retry, so
// caching that null saves a request. A city we failed to look up because
// of a 429 or a network blip must not be cached, or one transient error
// silently drops every plant in that city for the rest of the run.
const cityCache = new Map();
let rateLimitHits = 0;

// Warm the cache from the checked-in geocache so a run after a rebuild
// spends its network budget on genuinely new plants instead of re-asking
// Nominatim for towns we already resolved. Plants restored by
// durable:import are already skipped by the lat IS NULL filter; this
// covers new plants that happen to sit in a town we know.
function warmCacheFromDisk() {
  try {
    const { GEOCACHE_CSV, geoKey } = require('../src/durable');
    if (!fs.existsSync(GEOCACHE_CSV)) return 0;
    const rows = parse(fs.readFileSync(GEOCACHE_CSV, 'utf8'), { columns: true, skip_empty_lines: true, trim: true });
    let n = 0;
    for (const r of rows) {
      if (r.address) continue;               // street rows are per-plant, not reusable
      const lat = parseFloat(r.lat), lon = parseFloat(r.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      cityCache.set(`${String(r.city).toUpperCase()}|${String(r.state).toUpperCase()}`, { lat, lon, source: 'osm' });
      n++;
    }
    return n;
  } catch (e) {
    return 0;   // a warm cache is an optimisation, never a requirement
  }
}

async function cachedGeocode(city, state, address) {
  if (address) {
    // Street-level: no cache, always a fresh lookup. Caller has already
    // throttled at the top-level loop. A null here means the street
    // address simply isn't in OSM, which is common for rural plants, so
    // we fall through to the city centroid rather than giving up.
    try {
      const hit = await geocodeNominatim(city, state, address);
      if (hit) return hit;
    } catch (e) {
      // Fall through to the city-level attempt below.
    }
  }
  const key = `${city.toUpperCase()}|${state.toUpperCase()}`;
  if (cityCache.has(key)) return cityCache.get(key);

  let result = null;
  let failed = false;
  try {
    result = await geocodeNominatim(city, state);
  } catch (e) {
    failed = true;
  }
  if (!result) {
    try {
      result = await geocodeCensus(city, state);
    } catch (e) {
      failed = true;
    }
  }
  // Cache a confirmed "no such place", but leave a failed lookup uncached
  // so a later plant in the same city gets another chance.
  if (result || !failed) cityCache.set(key, result);
  if (!result && failed) throw new Error(`lookup failed for ${city}, ${state}`);
  return result;
}

(async () => {
  const runStarted = new Date().toISOString();
  const where = FORCE ? '' : ' AND (lat IS NULL OR lon IS NULL)';
  const rows = db.prepare(`
    SELECT id, plant_code, address, city, state FROM plants
    WHERE city IS NOT NULL AND state IS NOT NULL${where}
    LIMIT ${MAX}
  `).all();
  const warmed = warmCacheFromDisk();
  console.log(`[geocode] ${rows.length} plants to geocode${FORCE ? ' (FORCE)' : ''}; ~${SLEEP_MS}ms per network call` +
    (warmed ? ` (${warmed} cities pre-loaded from data/durable/geocache.csv)` : ''));

  const update = db.prepare(`
    UPDATE plants SET lat = ?, lon = ?, geocoded_at = datetime('now') WHERE id = ?
  `);

  let ok = 0, miss = 0, err = 0, rejected = 0, sourceCounts = { osm: 0, 'osm-street': 0, census: 0 };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const cityKey = `${r.city.toUpperCase()}|${r.state.toUpperCase()}`;
    // Street lookups always hit the network; city lookups are cached.
    const willHitNetwork = !!r.address || !cityCache.has(cityKey);
    try {
      const hit = await cachedGeocode(r.city, r.state, r.address);
      if (hit && isOutsideState(hit.lat, hit.lon, r.state)) {
        // Nominatim matched a same-named town in the wrong state. Reject
        // rather than plant a phantom pin.
        rejected++;
        if (rejected <= 5) console.error(`  rejected out-of-state ${r.plant_code} (${r.city}, ${r.state}): ${hit.lat.toFixed(2)},${hit.lon.toFixed(2)}`);
      } else if (hit) {
        update.run(hit.lat, hit.lon, r.id);
        ok++;
        if (hit.source) sourceCounts[hit.source] = (sourceCounts[hit.source] || 0) + 1;
      } else {
        miss++;
      }
    } catch (e) {
      err++;
      if (err <= 5) console.error(`  err ${r.plant_code} (${r.city}, ${r.state}): ${e.message}`);
    }
    if ((i + 1) % 100 === 0) {
      console.log(`  ${i + 1}/${rows.length}  ok=${ok} miss=${miss} rejected=${rejected} err=${err} throttled=${rateLimitHits}  cities cached=${cityCache.size}  (street=${sourceCounts['osm-street']} osm=${sourceCounts.osm} census=${sourceCounts.census})`);
    }
    if (willHitNetwork) await sleep(SLEEP_MS);
  }

  db.prepare(`
    INSERT INTO ingest_runs (source, started_at, finished_at, rows_in, rows_written, notes)
    VALUES ('geocode', ?, ?, ?, ?, ?)
  `).run(runStarted, new Date().toISOString(), rows.length, ok,
    `miss=${miss} err=${err} throttled=${rateLimitHits} cities=${cityCache.size} street=${sourceCounts['osm-street']} osm=${sourceCounts.osm} census=${sourceCounts.census}`);

  console.log(`[geocode] done. ok=${ok} miss=${miss} rejected=${rejected} err=${err} throttled=${rateLimitHits} (${cityCache.size} unique cities; street=${sourceCounts['osm-street']} osm=${sourceCounts.osm} census=${sourceCounts.census})`);
  if (err) {
    console.log(`[geocode] ${err} lookups FAILED (not the same as "not found") — re-run to retry just those rows.`);
  }
  if (ok) {
    console.log('[geocode] run "npm run durable:export" and commit data/durable/ so this survives the next deploy.');
  }
})().catch(e => { console.error(e); process.exit(1); });

