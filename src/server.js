const path = require('path');
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

app.get('/about', (_req, res) => res.render('about'));

app.use((req, res) => res.status(404).render('not_found', { kind: 'page', value: req.path }));

app.listen(PORT, () => {
  console.log(`plant-track listening on http://localhost:${PORT}`);
});
