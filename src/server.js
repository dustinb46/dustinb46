const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const { db } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

app.locals.disclaimer = (
  'Plant Track is informational and not authoritative. Mappings show a ' +
  'source and a confidence level — verify before publishing or citing. ' +
  'Corrections welcome.'
);

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
  return db.prepare(`
    SELECT * FROM recalls
    WHERE plant_id = ?
    ORDER BY COALESCE(recall_date, report_date) DESC
  `).all(plant_id);
}

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
  res.render('index', { stats, recent });
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

  res.render('search', { q, state, parent, plants, brands, aliasHit });
});

app.get('/plant/:code', (req, res) => {
  const hit = plantByAnyCode(req.params.code);
  if (!hit) return res.status(404).render('not_found', { kind: 'plant', value: req.params.code });
  const { plant, via } = hit;
  res.render('plant', {
    plant,
    via,
    brands: brandsForPlant(plant.id),
    recalls: recallsForPlant(plant.id),
    aliases: db.prepare(`SELECT * FROM plant_code_aliases WHERE plant_id = ?`).all(plant.id),
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

app.get('/timeline', (req, res) => {
  const { sql: filterSql, params } = buildRecallFilter(req.query);
  const baseFrom = `FROM recalls r LEFT JOIN plants p ON p.id = r.plant_id WHERE ${filterSql}`;

  const monthly = db.prepare(`
    SELECT substr(COALESCE(r.recall_date, r.report_date), 1, 7) AS ym,
           COUNT(*) AS n,
           SUM(CASE WHEN r.classification = 'Class I'   THEN 1 ELSE 0 END) AS c1,
           SUM(CASE WHEN r.classification = 'Class II'  THEN 1 ELSE 0 END) AS c2,
           SUM(CASE WHEN r.classification = 'Class III' THEN 1 ELSE 0 END) AS c3
    ${baseFrom} AND COALESCE(r.recall_date, r.report_date) IS NOT NULL
    GROUP BY ym ORDER BY ym DESC LIMIT 60
  `).all(...params);

  const topFirms = db.prepare(`
    SELECT r.firm_name, COUNT(*) AS n,
           SUM(CASE WHEN r.classification = 'Class I' THEN 1 ELSE 0 END) AS c1
    ${baseFrom} AND r.firm_name IS NOT NULL
    GROUP BY r.firm_name ORDER BY n DESC LIMIT 15
  `).all(...params);

  const byClass = db.prepare(`
    SELECT COALESCE(r.classification, '(unknown)') AS classification, COUNT(*) AS n
    ${baseFrom} GROUP BY classification ORDER BY n DESC
  `).all(...params);

  const total = db.prepare(`SELECT COUNT(*) AS n ${baseFrom}`).get(...params).n;
  const matched = db.prepare(`SELECT COUNT(*) AS n ${baseFrom} AND r.plant_id IS NOT NULL`).get(...params).n;

  const recent = db.prepare(`
    SELECT r.*, p.plant_code, p.name AS plant_name
    ${baseFrom}
    ORDER BY COALESCE(r.recall_date, r.report_date) DESC
    LIMIT 50
  `).all(...params);

  res.render('timeline', {
    filters: req.query,
    monthly,
    topFirms,
    byClass,
    total,
    matched,
    recent,
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
  res.setHeader('Content-Disposition', 'attachment; filename="plant-track-recalls.csv"');
  res.write(cols.join(',') + '\n');
  for (const r of rows) res.write(cols.map(c => csvEscape(r[c])).join(',') + '\n');
  res.end();
});

// ---------------- admin: ingest run history (read-only) ----------------

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
};

function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return res.status(503).json({ error: 'ADMIN_TOKEN not configured' });
  const got = req.header('X-Admin-Token') || req.query.token;
  if (got !== expected) return res.status(401).json({ error: 'unauthorized' });
  next();
}

app.post('/admin/run/:name', requireAdmin, (req, res) => {
  const script = ADMIN_SCRIPTS[req.params.name];
  if (!script) return res.status(404).json({ error: 'unknown script', allowed: Object.keys(ADMIN_SCRIPTS) });
  const env = { ...process.env };
  if (req.query.url)       env.IMS_PDF_URL = String(req.query.url);
  if (req.query.max_pages) env.RECALL_MAX_PAGES = String(req.query.max_pages);
  if (req.query.grep)      env.IMS_GREP = String(req.query.grep);
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
});
