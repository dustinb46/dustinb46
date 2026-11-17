'use strict';
// One record shape for everything that happens to a plant or a herd.
//
// The atlas stores plant news, FDA recalls and herd dispersals in three
// tables with three different shapes. The layered map, the "what changed"
// panel, /api/records.json and /feed.xml all want the same thing from
// them: a type, a date, a place and a source. This module turns each
// table's rows into that one shape, so a map layer is a filter on `type`,
// a lens is a saved set of layers, and the feed is the same records
// sorted by date.
//
// Adding a new signal later means one more normalizer and one more query
// in loadRecords(). It does not mean a new page.
//
// Everything except loadRecords() is pure and unit-tested. loadRecords()
// takes the db handle as an argument so requiring this file never opens
// the database.

const crypto = require('crypto');

// Record types, and the map layers that show them. "plants" is the base
// layer: always on, and not a record type. "supply" is the FDA list's bulk
// tank units and receiving/transfer stations (see src/naming.js): drawn
// from the same plant data, off unless the reader turns it on.
const LAYERS = ['plants', 'supply', 'events', 'dispersals', 'recalls'];
const LAYER_TYPE = { events: 'event', dispersals: 'dispersal', recalls: 'recall' };
const TYPES = Object.values(LAYER_TYPE);

// Time windows the map offers, in days. 0 means all time.
const WINDOWS = [90, 365, 0];
const DEFAULT_DAYS = 365;

// A lens is a question with a fixed set of layers. Order here is the
// order of the buttons on the page.
const LENSES = [
  {
    id: 'capacity',
    label: 'Where is capacity moving?',
    blurb: 'Openings, expansions, closures and ownership changes, over every plant in the atlas.',
    layers: ['plants', 'events'],
  },
  {
    id: 'exits',
    label: 'Where are herds exiting?',
    blurb: 'Herd dispersal listings, pinned where the sale is held, over every plant in the atlas.',
    layers: ['plants', 'dispersals'],
  },
  {
    id: 'buyers',
    label: 'Who buys milk here?',
    blurb: 'Every plant in the atlas. Click the map to count the plants within reach of that spot.',
    layers: ['plants'],
    tool: 'radius',
  },
  {
    id: 'safety',
    label: 'Food safety record',
    blurb: 'FDA recalls that are matched to a plant, over every plant in the atlas. Unmatched recalls are listed but never pinned.',
    layers: ['plants', 'recalls'],
  },
];

function parseDays(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_DAYS;
  const n = Number(raw);
  return WINDOWS.includes(n) ? n : DEFAULT_DAYS;
}

// "events,recalls" -> ['plants', 'events', 'recalls']. Unknown names are
// dropped, duplicates collapse, plants is always present, and the result
// is in LAYERS order so the same view always produces the same URL.
function parseLayers(raw) {
  const asked = new Set(
    String(raw == null ? '' : raw).toLowerCase().split(',').map(s => s.trim())
  );
  return LAYERS.filter(l => l === 'plants' || asked.has(l));
}

// Turn a query string into a view. A valid lens wins over a layers list;
// a layers list with no valid lens is a custom view; anything else is
// the first lens.
function resolveView(query) {
  const q = query || {};
  const days = parseDays(q.days);
  const lensId = String(q.lens == null ? '' : q.lens).toLowerCase();
  const lens = LENSES.find(l => l.id === lensId);
  if (!lens && q.layers !== undefined && q.layers !== null) {
    return { lens: 'custom', layers: parseLayers(q.layers), days };
  }
  const chosen = lens || LENSES[0];
  return { lens: chosen.id, layers: chosen.layers.slice(), days };
}

// The query string that reproduces a view. Defaults are left out so the
// common links stay short.
function viewQuery(view) {
  const parts = [];
  if (view.lens === 'custom') parts.push('layers=' + view.layers.join(','));
  else parts.push('lens=' + view.lens);
  if (view.days !== DEFAULT_DAYS) parts.push('days=' + view.days);
  return parts.join('&');
}

// ISO date (YYYY-MM-DD) `days` before `now`, or null for all time.
function sinceDate(days, now) {
  if (!days) return null;
  const d = new Date((now || new Date()).getTime() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function typesFromQuery(raw) {
  if (raw === undefined || raw === null || raw === '') return TYPES.slice();
  const asked = new Set(String(raw).toLowerCase().split(',').map(s => s.trim()));
  const out = TYPES.filter(t => asked.has(t));
  return out.length ? out : TYPES.slice();
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clip(text, max) {
  if (!text) return null;
  const s = String(text).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

// A record is pinned at the plant when it is linked to one. Failing
// that, at the centre of its town, and it says so.
function place(plantLat, plantLon, cityLat, cityLon) {
  const pl = num(plantLat), po = num(plantLon);
  if (pl !== null && po !== null) return { lat: pl, lon: po, located_by: 'plant' };
  const cl = num(cityLat), co = num(cityLon);
  if (cl !== null && co !== null) return { lat: cl, lon: co, located_by: 'city' };
  return { lat: null, lon: null, located_by: null };
}

function normalizeNews(row) {
  const at = place(row.plant_lat, row.plant_lon, row.city_lat, row.city_lon);
  return {
    id: 'event-' + row.id,
    type: 'event',
    kind: row.kind || 'other',
    date: row.event_date,
    title: row.headline,
    summary: clip(row.body, 280),
    firm: row.firm_name || null,
    city: row.city || null,
    state: row.state || null,
    plant_code: row.plant_code || null,
    plant_name: row.plant_name || null,
    lat: at.lat, lon: at.lon, located_by: at.located_by,
    source_url: row.source_url || null,
    source_name: row.source_name || null,
  };
}

// A recall is only ever pinned at a plant it has been matched to. The
// recalling firm's own city is not the plant, so an unmatched recall gets
// no pin at all rather than a guess.
function normalizeRecall(row) {
  const matched = !!row.plant_code;
  const at = matched
    ? place(row.plant_lat, row.plant_lon, null, null)
    : { lat: null, lon: null, located_by: null };
  return {
    id: 'recall-' + row.event_key,
    type: 'recall',
    kind: row.classification || 'Recall',
    date: row.event_date,
    title: matched ? row.plant_name : (row.firm_name || 'Unknown firm'),
    summary: clip(row.reason, 280),
    firm: row.firm_name || null,
    city: (matched ? row.plant_city : row.firm_city) || null,
    state: (matched ? row.plant_state : row.firm_state) || null,
    plant_code: row.plant_code || null,
    plant_name: row.plant_name || null,
    lat: at.lat, lon: at.lon, located_by: at.located_by,
    source_url: null,
    source_name: 'openFDA',
    product_count: row.product_count || 1,
  };
}

function normalizeDispersal(row) {
  const own = num(row.lat) !== null && num(row.lon) !== null;
  const at = own
    ? { lat: num(row.lat), lon: num(row.lon), located_by: 'listing' }
    : place(null, null, row.city_lat, row.city_lon);
  const facts = [
    row.head_count ? Number(row.head_count).toLocaleString('en-US') + ' head' : null,
    row.herd_type || null,
    row.auctioneer || null,
  ].filter(Boolean);
  return {
    id: 'dispersal-' + row.id,
    type: 'dispersal',
    kind: 'dispersal',
    date: row.event_date,
    title: row.headline,
    summary: facts.length ? facts.join(' · ') : null,
    firm: row.auctioneer || null,
    city: row.city || null,
    county: row.county || null,
    state: row.state || null,
    plant_code: null,
    plant_name: null,
    lat: at.lat, lon: at.lon, located_by: at.located_by,
    source_url: row.source_url || null,
    source_name: row.source_name || null,
    head_count: row.head_count || null,
  };
}

// Newest first. Ties break on id so the order is stable between requests.
function sortRecords(records) {
  return records.slice().sort((a, b) =>
    (b.date || '').localeCompare(a.date || '') || a.id.localeCompare(b.id));
}

// ---------------- dispersal CSV rows ----------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validIsoDate(s) {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function dispersalFingerprint(eventDate, headline, sourceUrl) {
  return crypto.createHash('sha1')
    .update([eventDate, headline, sourceUrl].map(s => String(s).trim().toLowerCase()).join('|'))
    .digest('hex');
}

// Validate one CSV row. Returns { ok: true, value } or { ok: false, reason }.
// A row without a date, a headline, a state or a source link is refused:
// the same rule the news and brand loaders apply, nothing unsourced.
function parseDispersalRow(row) {
  const r = row || {};
  const get = k => (r[k] === undefined || r[k] === null ? '' : String(r[k]).trim());
  const event_date = get('event_date');
  const headline = get('headline');
  const source_url = get('source_url');
  const state = get('state').toUpperCase();
  if (!validIsoDate(event_date)) return { ok: false, reason: 'event_date must be YYYY-MM-DD' };
  if (!headline) return { ok: false, reason: 'headline is required' };
  if (!/^https?:\/\/\S+$/i.test(source_url)) return { ok: false, reason: 'source_url must be an http(s) link' };
  if (!/^[A-Z]{2}$/.test(state)) return { ok: false, reason: 'state must be a two-letter code' };

  let head_count = null;
  const hc = get('head_count').replace(/,/g, '');
  if (hc) {
    if (!/^\d+$/.test(hc)) return { ok: false, reason: 'head_count must be a whole number' };
    head_count = Number(hc);
  }

  // Coordinates are optional, but half a pair or an out-of-range value is
  // a typo, not a location.
  let lat = null, lon = null;
  const la = get('lat'), lo = get('lon');
  if (la || lo) {
    lat = num(la); lon = num(lo);
    if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return { ok: false, reason: 'lat and lon must both be valid numbers' };
    }
  }

  return {
    ok: true,
    value: {
      event_date, headline, head_count,
      herd_type: get('herd_type') || null,
      city: get('city') || null,
      county: get('county') || null,
      state, lat, lon,
      auctioneer: get('auctioneer') || null,
      source_url,
      source_name: get('source_name') || null,
      added_by: get('added_by') || null,
      fingerprint: dispersalFingerprint(event_date, headline, source_url),
    },
  };
}

// ---------------- RSS ----------------

function xml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function kindLabel(r) {
  if (r.type === 'recall') return r.kind === 'Recall' ? 'Recall' : 'Recall, ' + r.kind;
  if (r.type === 'dispersal') return 'Herd dispersal';
  return r.kind.charAt(0).toUpperCase() + r.kind.slice(1);
}

// Where a record's link goes: its source, else its plant page, else the feed.
function recordLink(r, abs) {
  if (r.source_url) return r.source_url;
  if (r.plant_code) return abs('/plant/' + encodeURIComponent(r.plant_code));
  return abs('/timeline');
}

function toRss(records, opts) {
  const { abs, title, description, selfPath } = opts;
  const items = records.map(r => {
    const where = [r.city, r.state].filter(Boolean).join(', ');
    const desc = [r.summary, where, r.source_name ? 'Source: ' + r.source_name : null]
      .filter(Boolean).join(' | ');
    // Noon UTC keeps the date from sliding a day in any US time zone.
    const when = validIsoDate(r.date) ? new Date(r.date + 'T12:00:00Z').toUTCString() : null;
    return [
      '    <item>',
      `      <title>${xml(kindLabel(r) + ': ' + r.title)}</title>`,
      `      <link>${xml(recordLink(r, abs))}</link>`,
      `      <guid isPermaLink="false">${xml(r.id)}</guid>`,
      when ? `      <pubDate>${when}</pubDate>` : null,
      desc ? `      <description>${xml(desc)}</description>` : null,
      '    </item>',
    ].filter(Boolean).join('\n');
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    `    <title>${xml(title)}</title>`,
    `    <link>${xml(abs('/map'))}</link>`,
    `    <description>${xml(description)}</description>`,
    `    <atom:link href="${xml(abs(selfPath))}" rel="self" type="application/rss+xml" />`,
    items.join('\n'),
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}

// ---------------- database ----------------

function tableExists(db, name) {
  return !!db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`
  ).get(name);
}

// Every record in the window, all types, newest first.
function loadRecords(db, opts) {
  const o = opts || {};
  const since = sinceDate(o.days === undefined ? DEFAULT_DAYS : o.days, o.now);
  const out = [];

  // Town centres, from the plants we have already geocoded. Used only for
  // records that are not linked to a plant.
  const centres = new Map();
  for (const c of db.prepare(`
    SELECT UPPER(TRIM(city)) AS city, UPPER(TRIM(state)) AS state,
           AVG(lat) AS lat, AVG(lon) AS lon
    FROM plants
    WHERE lat IS NOT NULL AND lon IS NOT NULL AND city IS NOT NULL AND state IS NOT NULL
    GROUP BY 1, 2
  `).all()) {
    centres.set(c.city + '|' + c.state, c);
  }
  const centre = (city, state) =>
    centres.get(String(city || '').trim().toUpperCase() + '|' + String(state || '').trim().toUpperCase())
    || { lat: null, lon: null };

  // Plant news.
  const news = db.prepare(`
    SELECT n.id, n.event_date, n.kind, n.headline, n.body, n.firm_name,
           n.city, n.state, n.source_url, n.source_name,
           p.plant_code, p.name AS plant_name, p.lat AS plant_lat, p.lon AS plant_lon
    FROM news_items n LEFT JOIN plants p ON p.id = n.plant_id
    ${since ? 'WHERE n.event_date >= ?' : ''}
  `).all(...(since ? [since] : []));
  for (const row of news) {
    const c = centre(row.city, row.state);
    out.push(normalizeNews({ ...row, city_lat: c.lat, city_lon: c.lon }));
  }

  // Recalls. openFDA publishes one row per recalled product, so group by
  // event, the same way /timeline does. MIN(classification) is the most
  // serious class in the event ('Class I' sorts first).
  const recalls = db.prepare(`
    SELECT COALESCE(NULLIF(r.event_id, ''), r.recall_number) AS event_key,
           MAX(COALESCE(r.recall_date, r.report_date)) AS event_date,
           MAX(r.firm_name) AS firm_name,
           MAX(r.firm_city) AS firm_city,
           MAX(r.firm_state) AS firm_state,
           MIN(r.classification) AS classification,
           MAX(r.reason) AS reason,
           MAX(r.plant_id) AS plant_id,
           COUNT(*) AS product_count
    FROM recalls r
    WHERE COALESCE(r.recall_date, r.report_date) IS NOT NULL
      ${since ? 'AND COALESCE(r.recall_date, r.report_date) >= ?' : ''}
    GROUP BY event_key
  `).all(...(since ? [since] : []));
  const plantById = db.prepare(
    `SELECT plant_code, name, city, state, lat, lon FROM plants WHERE id = ?`
  );
  for (const row of recalls) {
    const p = row.plant_id ? plantById.get(row.plant_id) : null;
    out.push(normalizeRecall({
      ...row,
      plant_code: p ? p.plant_code : null,
      plant_name: p ? p.name : null,
      plant_city: p ? p.city : null,
      plant_state: p ? p.state : null,
      plant_lat: p ? p.lat : null,
      plant_lon: p ? p.lon : null,
    }));
  }

  // Herd dispersals. The table is created by init-db; on a database that
  // has not been through it yet there is simply nothing to show.
  if (tableExists(db, 'dispersals')) {
    const rows = db.prepare(`
      SELECT * FROM dispersals ${since ? 'WHERE event_date >= ?' : ''}
    `).all(...(since ? [since] : []));
    for (const row of rows) {
      const c = centre(row.city, row.state);
      out.push(normalizeDispersal({ ...row, city_lat: c.lat, city_lon: c.lon }));
    }
  }

  return sortRecords(out);
}

module.exports = {
  LAYERS, LAYER_TYPE, TYPES, WINDOWS, DEFAULT_DAYS, LENSES,
  parseDays, parseLayers, resolveView, viewQuery, sinceDate, typesFromQuery,
  normalizeNews, normalizeRecall, normalizeDispersal, sortRecords,
  parseDispersalRow, dispersalFingerprint, validIsoDate,
  kindLabel, recordLink, toRss, loadRecords,
};
