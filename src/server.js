const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const { db } = require('./db');
const fs = require('fs');
const { facilityKey } = require('./facility');
const { heroImagePath, ensureAssetDir } = require('./paths');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

app.locals.disclaimer = (
  'An educational reference built from public sources. ' +
  'Spot something off? Send us a note.'
);
app.locals.siteName = 'DairyPlant Atlas';

// ---------------- helpers ----------------

function ftsQuery(raw) {
  // Defensively quote each token for FTS5 to avoid syntax errors on
  // user input containing dashes, etc.
  return raw
    .split(/\s+/)
    .filter(Boolean)
    .map(t => `"${t.replace(/"/g, '""')}"*`)
    .join(' ');
}

function plantById(id) {
  return db.prepare(`SELECT * FROM plants WHERE id = ?`).get(id);
}
function plantByCode(code) {
  return db.prepare(`SELECT * FROM plants WHERE plant_code = ?`).get(code);
}
function plantByAnyCode(code) {
  const direct = plantByCode(code);
  if (direct) return { plant: direct, via: 'ims' };
  const alias = db.prepare(
    `SELECT p.*, a.code_system AS via
     FROM plant_code_aliases a
     JOIN plants p ON p.id = a.plant_id
     WHERE a.code = ?`
  ).get(code);
  if (alias) {
    const { via, ...plant } = alias;
    return { plant, via };
  }
  return null;
}

function brandsForPlant(plant_id) {
  return db.prepare(`
    SELECT pb.*, b.brand_name, b.brand_type, b.parent_company
    FROM plant_brands pb
    JOIN brands b ON b.id = pb.brand_id
    WHERE pb.plant_id = ?
    ORDER BY pb.confidence DESC, b.brand_name
  `).all(plant_id);
}

function recallsForPlant(plant_id) {
  // Collapse openFDA's per-product rows into one row per recall event.
  return db.prepare(`
    SELECT COALESCE(NULLIF(event_id, ''), recall_number) AS event_key,
           MAX(COALESCE(recall_date, report_date)) AS recall_date,
           MAX(classification) AS classification,
           MAX(reason) AS reason,
           MAX(status) AS status,
           MAX(match_method) AS match_method,
           MAX(match_confidence) AS match_confidence,
           COUNT(*) AS product_count
    FROM recalls
    WHERE plant_id = ?
    GROUP BY event_key
    ORDER BY recall_date DESC
  `).all(plant_id);
}

const logSearch = db.prepare(`
  INSERT INTO search_log (q, state_filter, parent_filter, plant_hits, brand_hits, alias_hit)
  VALUES (?, ?, ?, ?, ?, ?)
`);

function plantsForBrand(brand_id) {
  return db.prepare(`
    SELECT pb.*, p.plant_code, p.name AS plant_name, p.city, p.state
    FROM plant_brands pb
    JOIN plants p ON p.id = pb.plant_id
    WHERE pb.brand_id = ?
    ORDER BY pb.confidence DESC, p.name
  `).all(brand_id);
}

// ---------------- routes ----------------

app.get('/', (req, res) => {
  const stats = {
    plants:   db.prepare(`SELECT COUNT(*) AS n FROM plants`).get().n,
    brands:   db.prepare(`SELECT COUNT(*) AS n FROM brands`).get().n,
    mappings: db.prepare(`SELECT COUNT(*) AS n FROM plant_brands`).get().n,
    recalls:  db.prepare(`SELECT COUNT(*) AS n FROM recalls`).get().n,
  };
  const recent = db.prepare(`
    SELECT r.*, p.plant_code, p.name AS plant_name
    FROM recalls r LEFT JOIN plants p ON p.id = r.plant_id
    ORDER BY COALESCE(r.recall_date, r.report_date) DESC
    LIMIT 10
  `).all();
  // Cache-busted hero photo URL when one has been uploaded, so we set
  // --hero-photo only when the file exists (no 404s on every load).
  let heroPhoto = null;
  try {
    const st = fs.statSync(heroImagePath());
    heroPhoto = `/hero-image?v=${Math.floor(st.mtimeMs)}`;
  } catch { /* no hero uploaded yet */ }
  res.render('index', { stats, recent, heroPhoto });
});

// Serve the uploaded hero image off the volume.
app.get('/hero-image', (_req, res) => {
  const p = heroImagePath();
  if (!fs.existsSync(p)) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(p);
});

// JSON plant search — useful for programmatic lookups and resolving
// exact plant codes by name.
// Compact lat/lon dump for the home-page map. Cached for an hour
// because plants change infrequently and the map fetches it on every
// page load. Plants are grouped into "facilities" (operator + city +
// state) so codes that describe the same physical building become a
// single pin with N codes inside, rather than N pins stacked at the
// same city centroid.
let geoCache = null, geoCacheTs = 0;
app.get('/api/plants/geo.json', (_req, res) => {
  const now = Date.now();
  if (!geoCache || (now - geoCacheTs) > 60 * 60 * 1000) {
    const rows = db.prepare(`
      SELECT plant_code, name, city, state, category, lat, lon
      FROM plants
      WHERE lat IS NOT NULL AND lon IS NOT NULL
    `).all();
    const groups = new Map();
    for (const r of rows) {
      // Cluster key: facility key when we can compute one, else fall
      // back to exact lat/lon so unmatched rows still render once.
      const fk = facilityKey(r.name, r.city, r.state)
              || `latlon|${r.lat}|${r.lon}|${r.plant_code}`;
      let g = groups.get(fk);
      if (!g) {
        g = { lat: r.lat, lon: r.lon, city: r.city, state: r.state,
              name: r.name, category: r.category, codes: [] };
        groups.set(fk, g);
      }
      g.codes.push({ plant_code: r.plant_code, name: r.name, category: r.category });
    }
    // Tiny lat/lon jitter when multiple distinct facilities share an
    // exact city centroid, so they don't render perfectly on top of
    // each other at high zoom.
    const byPoint = new Map();
    for (const g of groups.values()) {
      const k = `${g.lat.toFixed(4)}|${g.lon.toFixed(4)}`;
      if (!byPoint.has(k)) byPoint.set(k, []);
      byPoint.get(k).push(g);
    }
    for (const arr of byPoint.values()) {
      if (arr.length <= 1) continue;
      // Evenly distribute around a tiny circle (~150m at most US lats).
      arr.forEach((g, i) => {
        const angle = (2 * Math.PI * i) / arr.length;
        g.lat = g.lat + 0.0015 * Math.sin(angle);
        g.lon = g.lon + 0.0015 * Math.cos(angle);
      });
    }
    geoCache = { count: groups.size, plants: [...groups.values()] };
    geoCacheTs = now;
  }
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json(geoCache);
});

app.get('/api/plants.json', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ count: 0, plants: [] });
  const rows = db.prepare(`
    SELECT p.plant_code, p.name, p.city, p.state, p.parent_company, p.ims_rating
    FROM plants_fts JOIN plants p ON p.id = plants_fts.rowid
    WHERE plants_fts MATCH ?
    ORDER BY rank LIMIT 50
  `).all(ftsQuery(q));
  res.json({ count: rows.length, plants: rows });
});

app.get('/search', (req, res) => {
  const q = (req.query.q || '').trim();
  const state = (req.query.state || '').trim().toUpperCase();
  const parent = (req.query.parent || '').trim();

  let plants = [];
  let brands = [];
  let aliasHit = null;

  if (q) {
    // Plant code lookup short-circuit.
    aliasHit = plantByAnyCode(q);
    const fts = ftsQuery(q);
    plants = db.prepare(`
      SELECT p.* FROM plants_fts
      JOIN plants p ON p.id = plants_fts.rowid
      WHERE plants_fts MATCH ?
      ORDER BY rank LIMIT 50
    `).all(fts);
    brands = db.prepare(`
      SELECT b.* FROM brands_fts
      JOIN brands b ON b.id = brands_fts.rowid
      WHERE brands_fts MATCH ?
      ORDER BY rank LIMIT 50
    `).all(fts);
  }

  if (state) {
    plants = plants.filter(p => (p.state || '').toUpperCase() === state);
  }
  if (parent) {
    const needle = parent.toLowerCase();
    plants = plants.filter(p => (p.parent_company || '').toLowerCase().includes(needle));
  }

  // Log only non-empty queries so we can see what peers searched for
  // (especially zero-result queries — those tell us which mappings to
  // add next). No IP or user agent stored.
  if (q) {
    try {
      logSearch.run(q, state || null, parent || null,
        plants.length, brands.length, aliasHit ? 1 : 0);
    } catch (e) { /* swallow — never block a search on logging */ }
  }

  res.render('search', { q, state, parent, plants, brands, aliasHit });
});

app.get('/plant/:code', (req, res) => {
  const hit = plantByAnyCode(req.params.code);
  if (!hit) return res.status(404).render('not_found', { kind: 'plant', value: req.params.code });
  const { plant, via } = hit;
  // Other plant codes in our database that look like the same physical
  // facility (same operator + city + state). Surfaces IMS/USDA duplicates
  // and BTU/receiving-line sub-codes as "Also at this site".
  let related = [];
  const myKey = facilityKey(plant.name, plant.city, plant.state);
  if (myKey) {
    const sameCity = db.prepare(
      `SELECT id, plant_code, name, source, category FROM plants
       WHERE city = ? AND state = ? AND id != ?`
    ).all(plant.city, plant.state, plant.id);
    related = sameCity.filter(p => facilityKey(p.name, plant.city, plant.state) === myKey);
  }
  res.render('plant', {
    plant,
    via,
    brands: brandsForPlant(plant.id),
    recalls: recallsForPlant(plant.id),
    aliases: db.prepare(`SELECT * FROM plant_code_aliases WHERE plant_id = ?`).all(plant.id),
    related,
  });
});

app.get('/brand/:id', (req, res) => {
  const brand = db.prepare(`SELECT * FROM brands WHERE id = ?`).get(req.params.id);
  if (!brand) return res.status(404).render('not_found', { kind: 'brand', value: req.params.id });
  res.render('brand', { brand, plants: plantsForBrand(brand.id) });
});

app.get('/recalls', (req, res) => {
  const cls = (req.query.class || '').trim();
  const matched = req.query.matched;
  let sql = `SELECT r.*, p.plant_code, p.name AS plant_name
             FROM recalls r LEFT JOIN plants p ON p.id = r.plant_id WHERE 1=1`;
  const params = [];
  if (cls) {
    sql += ` AND r.classification = ?`;
    params.push(cls);
  }
  if (matched === 'yes') sql += ` AND r.plant_id IS NOT NULL`;
  if (matched === 'no')  sql += ` AND r.plant_id IS NULL`;
  sql += ` ORDER BY COALESCE(r.recall_date, r.report_date) DESC LIMIT 500`;
  const recalls = db.prepare(sql).all(...params);
  res.render('recalls', { recalls, cls, matched });
});

// ---------------- timeline (journalist view) ----------------

function buildRecallFilter(query) {
  const where = ['1=1'];
  const params = [];
  if (query.class) {
    where.push('r.classification = ?');
    params.push(String(query.class));
  }
  if (query.state) {
    where.push('UPPER(r.firm_state) = UPPER(?)');
    params.push(String(query.state));
  }
  if (query.from) {
    where.push("COALESCE(r.recall_date, r.report_date) >= ?");
    params.push(String(query.from));
  }
  if (query.to) {
    where.push("COALESCE(r.recall_date, r.report_date) <= ?");
    params.push(String(query.to));
  }
  if (query.firm) {
    where.push("LOWER(r.firm_name) LIKE ?");
    params.push('%' + String(query.firm).toLowerCase() + '%');
  }
  if (query.matched === 'yes') where.push('r.plant_id IS NOT NULL');
  if (query.matched === 'no')  where.push('r.plant_id IS NULL');
  return { sql: where.join(' AND '), params };
}

// openFDA publishes one row per recalled product, so a single recall
// event shows up many times. Group everything by event so the timeline
// counts distinct recalls, not SKUs. EVKEY falls back to recall_number
// for the rare rows with no event_id.
const EVKEY = `COALESCE(NULLIF(r.event_id, ''), r.recall_number)`;

app.get('/timeline', (req, res) => {
  const { sql: filterSql, params } = buildRecallFilter(req.query);
  const baseFrom = `FROM recalls r LEFT JOIN plants p ON p.id = r.plant_id WHERE ${filterSql}`;

  const monthly = db.prepare(`
    SELECT substr(COALESCE(r.recall_date, r.report_date), 1, 7) AS ym,
           COUNT(DISTINCT ${EVKEY}) AS n,
           COUNT(DISTINCT CASE WHEN r.classification = 'Class I'   THEN ${EVKEY} END) AS c1,
           COUNT(DISTINCT CASE WHEN r.classification = 'Class II'  THEN ${EVKEY} END) AS c2,
           COUNT(DISTINCT CASE WHEN r.classification = 'Class III' THEN ${EVKEY} END) AS c3
    ${baseFrom} AND COALESCE(r.recall_date, r.report_date) IS NOT NULL
    GROUP BY ym ORDER BY ym DESC LIMIT 60
  `).all(...params);

  const topFirms = db.prepare(`
    SELECT r.firm_name, COUNT(DISTINCT ${EVKEY}) AS n,
           COUNT(DISTINCT CASE WHEN r.classification = 'Class I' THEN ${EVKEY} END) AS c1
    ${baseFrom} AND r.firm_name IS NOT NULL
    GROUP BY r.firm_name ORDER BY n DESC LIMIT 15
  `).all(...params);

  const byClass = db.prepare(`
    SELECT COALESCE(r.classification, '(unknown)') AS classification,
           COUNT(DISTINCT ${EVKEY}) AS n
    ${baseFrom} GROUP BY classification ORDER BY n DESC
  `).all(...params);

  const total = db.prepare(`SELECT COUNT(DISTINCT ${EVKEY}) AS n ${baseFrom}`).get(...params).n;
  const matched = db.prepare(
    `SELECT COUNT(DISTINCT CASE WHEN r.plant_id IS NOT NULL THEN ${EVKEY} END) AS n ${baseFrom}`
  ).get(...params).n;

  // The feed shows two item kinds — recall events and plant news — in
  // one chronological list. Each query returns its own normalized
  // shape and we merge in JS sorted by date.
  const kindFilter = (req.query.kind || '').toString().toLowerCase();
  const showRecalls = kindFilter !== 'news';
  const showNews    = kindFilter !== 'recalls';

  let recallItems = [];
  if (showRecalls) {
    recallItems = db.prepare(`
      SELECT ${EVKEY} AS event_key,
             MAX(COALESCE(r.recall_date, r.report_date)) AS event_date,
             MAX(r.firm_name) AS firm_name,
             MAX(r.classification) AS classification,
             MAX(r.reason) AS reason,
             MAX(r.plant_id) AS plant_id,
             MAX(p.plant_code) AS plant_code,
             MAX(p.name) AS plant_name,
             COUNT(*) AS product_count
      ${baseFrom}
      GROUP BY event_key
      ORDER BY event_date DESC
      LIMIT 100
    `).all(...params).map(r => ({ ...r, kind: 'recall' }));
  }

  // News items respect the firm/state/date filters where they overlap;
  // recall-only filters (class, matched) suppress news entirely.
  let newsItems = [];
  if (showNews && !req.query.class && !req.query.matched) {
    const w = ['1=1'];
    const np = [];
    if (req.query.state) { w.push('UPPER(state) = UPPER(?)'); np.push(String(req.query.state)); }
    if (req.query.firm)  { w.push('LOWER(firm_name) LIKE ?'); np.push('%' + String(req.query.firm).toLowerCase() + '%'); }
    if (req.query.from)  { w.push('event_date >= ?'); np.push(String(req.query.from)); }
    if (req.query.to)    { w.push('event_date <= ?'); np.push(String(req.query.to)); }
    newsItems = db.prepare(`
      SELECT n.id, n.event_date, n.kind AS news_kind, n.headline, n.body,
             n.firm_name, n.city, n.state, n.source_url, n.source_name,
             n.plant_id, p.plant_code, p.name AS plant_name
      FROM news_items n LEFT JOIN plants p ON p.id = n.plant_id
      WHERE ${w.join(' AND ')}
      ORDER BY event_date DESC LIMIT 100
    `).all(...np).map(r => ({ ...r, kind: 'news' }));
  }

  // Merge and clamp to the most recent 100 of either kind combined.
  const feed = [...recallItems, ...newsItems]
    .sort((a, b) => (b.event_date || '').localeCompare(a.event_date || ''))
    .slice(0, 100);

  res.render('timeline', {
    filters: req.query,
    monthly,
    topFirms,
    byClass,
    total,
    matched,
    newsTotal: newsItems.length,   // for the stats strip
    recent: feed,
  });
});

// ---------------- JSON / CSV exports for press use ----------------

function recallRowsForExport(query) {
  const { sql, params } = buildRecallFilter(query);
  return db.prepare(`
    SELECT r.recall_number, r.recall_date, r.report_date, r.classification,
           r.status, r.firm_name, r.firm_city, r.firm_state,
           r.reason, r.product_description,
           r.match_method, r.match_confidence,
           p.plant_code, p.name AS plant_name
    FROM recalls r LEFT JOIN plants p ON p.id = r.plant_id
    WHERE ${sql}
    ORDER BY COALESCE(r.recall_date, r.report_date) DESC
    LIMIT 5000
  `).all(...params);
}

app.get('/api/recalls.json', (req, res) => {
  const rows = recallRowsForExport(req.query);
  res.json({ count: rows.length, generated_at: new Date().toISOString(), recalls: rows });
});

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

app.get('/api/recalls.csv', (req, res) => {
  const rows = recallRowsForExport(req.query);
  const cols = [
    'recall_number','recall_date','report_date','classification','status',
    'firm_name','firm_city','firm_state','reason','product_description',
    'match_method','match_confidence','plant_code','plant_name'
  ];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="dairyplant-atlas-recalls.csv"');
  res.write(cols.join(',') + '\n');
  for (const r of rows) res.write(cols.map(c => csvEscape(r[c])).join(',') + '\n');
  res.end();
});

// ---------------- admin: ingest run history (read-only) ----------------

app.get('/admin/searches', (_req, res) => {
  const recent = db.prepare(
    `SELECT * FROM search_log ORDER BY ts DESC LIMIT 200`
  ).all();
  const zero = db.prepare(`
    SELECT q, COUNT(*) AS n, MAX(ts) AS last_seen
    FROM search_log
    WHERE plant_hits = 0 AND brand_hits = 0 AND alias_hit = 0
    GROUP BY LOWER(q) ORDER BY n DESC, last_seen DESC LIMIT 50
  `).all();
  const top = db.prepare(`
    SELECT q, COUNT(*) AS n
    FROM search_log GROUP BY LOWER(q) ORDER BY n DESC LIMIT 30
  `).all();
  const totals = {
    total: db.prepare(`SELECT COUNT(*) AS n FROM search_log`).get().n,
    zero:  db.prepare(`SELECT COUNT(*) AS n FROM search_log WHERE plant_hits=0 AND brand_hits=0 AND alias_hit=0`).get().n,
  };
  res.render('admin_searches', { recent, zero, top, totals });
});

app.get('/admin/ingest', (_req, res) => {
  const runs = db.prepare(`
    SELECT * FROM ingest_runs ORDER BY started_at DESC LIMIT 100
  `).all();
  const counts = {
    plants:   db.prepare(`SELECT COUNT(*) AS n FROM plants`).get().n,
    ims:      db.prepare(`SELECT COUNT(*) AS n FROM plants WHERE source='IMS'`).get().n,
    brands:   db.prepare(`SELECT COUNT(*) AS n FROM brands`).get().n,
    mappings: db.prepare(`SELECT COUNT(*) AS n FROM plant_brands`).get().n,
    recalls:  db.prepare(`SELECT COUNT(*) AS n FROM recalls`).get().n,
    matched:  db.prepare(`SELECT COUNT(*) AS n FROM recalls WHERE plant_id IS NOT NULL`).get().n,
  };
  res.render('admin_ingest', { runs, counts });
});

// ---------------- admin: trigger ingest jobs ----------------
// Protected by ADMIN_TOKEN env var. Send as X-Admin-Token header.
// Streams script stdout/stderr back so you can see the run.

const ADMIN_SCRIPTS = {
  'ims-download': 'scripts/download-ims.js',
  'ims-ingest':   'scripts/ingest-ims.js',
  'ims-sanity':   'scripts/ingest-ims-sanity.js',
  'recalls-sync': 'scripts/sync-recalls.js',
  'seeds-load':   'scripts/load-seeds.js',
  'ims-dump':     'scripts/dump-ims.js',
  'resolve-plants': 'scripts/resolve-plants.js',
  'harvest-codes':  'scripts/harvest-recall-codes.js',
  'usda-ingest':    'scripts/ingest-usda.js',
  'geocode':        'scripts/geocode-plants.js',
  'match-brands':   'scripts/match-brands.js',
  'datcp-ingest':   'scripts/ingest-datcp.js',
};

function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return res.status(503).json({ error: 'ADMIN_TOKEN not configured' });
  const got = req.header('X-Admin-Token') || req.query.token;
  if (got !== expected) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// Upload (or replace) the homepage hero photo. Send the raw image bytes
// as the request body with an image/* content type:
//   curl -X POST -H "X-Admin-Token: $TOKEN" -H "Content-Type: image/jpeg" \
//        --data-binary "@hero.jpg" "$URL/admin/hero-image"
app.post('/admin/hero-image',
  requireAdmin,
  express.raw({ type: ['image/*'], limit: '12mb' }),
  (req, res) => {
    if (!req.body || !req.body.length) {
      return res.status(400).json({ error: 'empty body; send raw image bytes with --data-binary' });
    }
    try {
      ensureAssetDir();
      fs.writeFileSync(heroImagePath(), req.body);
      res.json({ ok: true, bytes: req.body.length, path: '/hero-image' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

app.post('/admin/run/:name', requireAdmin, (req, res) => {
  const script = ADMIN_SCRIPTS[req.params.name];
  if (!script) return res.status(404).json({ error: 'unknown script', allowed: Object.keys(ADMIN_SCRIPTS) });
  const env = { ...process.env };
  if (req.query.url)       env.IMS_PDF_URL = String(req.query.url);
  if (req.query.max_pages) env.RECALL_MAX_PAGES = String(req.query.max_pages);
  if (req.query.grep)      env.IMS_GREP = String(req.query.grep);
  if (req.query.queries)   env.IMS_QUERIES = String(req.query.queries);
  if (req.query.apply)     env.APPLY = String(req.query.apply);
  if (req.query.force)     env.FORCE = String(req.query.force);
  const extraArgs = [];
  if (req.query.from) extraArgs.push(String(req.query.from));
  if (req.query.to)   extraArgs.push(String(req.query.to));
  const child = spawn('node', [script, ...extraArgs], {
    cwd: path.join(__dirname, '..'),
    env,
  });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.write(`# running ${script}\n`);
  child.stdout.on('data', d => res.write(d));
  child.stderr.on('data', d => res.write(d));
  child.on('close', code => {
    res.write(`\n# exit ${code}\n`);
    res.end();
  });
  child.on('error', err => {
    res.write(`\n# spawn error: ${err.message}\n`);
    res.end();
  });
});

app.get('/about', (_req, res) => res.render('about'));

app.use((req, res) => res.status(404).render('not_found', { kind: 'page', value: req.path }));

app.listen(PORT, () => {
  console.log(`plant-track listening on http://localhost:${PORT}`);
  require('./scheduler').start();
});
