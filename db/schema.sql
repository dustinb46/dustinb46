-- Plant Track schema
-- v1 is IMS-only for fluid/cultured Grade A plants.
-- See README for the rationale on each table and column.

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS plants (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  plant_code      TEXT NOT NULL UNIQUE,        -- canonical IMS code, e.g. "55-23"
  name            TEXT NOT NULL,
  address         TEXT,
  city            TEXT,
  state           TEXT,
  category        TEXT,                        -- Grade A fluid / cultured / cheese / mfg
  parent_company  TEXT,
  fmmo_pool       TEXT,                        -- FMMO order number(s), comma-sep
  ims_rating      TEXT,
  source          TEXT,                        -- e.g. "IMS 2024-Q4", "manual"
  last_verified   TEXT,                        -- ISO date
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

-- A single physical plant can be referenced by multiple code systems:
-- IMS state-number, FDA food facility registration, USDA establishment.
-- Without this, packaging codes from non-IMS systems will silently 404.
CREATE TABLE IF NOT EXISTS plant_code_aliases (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  plant_id      INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
  code          TEXT NOT NULL,
  code_system   TEXT NOT NULL,                 -- ims | fda_ffr | usda_est | state
  notes         TEXT,
  UNIQUE(code, code_system)
);
CREATE INDEX IF NOT EXISTS idx_plant_code_aliases_code ON plant_code_aliases(code);

CREATE TABLE IF NOT EXISTS brands (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_name     TEXT NOT NULL UNIQUE,
  brand_type     TEXT,                         -- national | regional | private_label
  parent_company TEXT
);

-- Many-to-many. Region field is required because private-label milk
-- is routinely sourced from whichever processor is closest to the DC,
-- so a brand maps to different plants in different regions.
CREATE TABLE IF NOT EXISTS plant_brands (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  plant_id          INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
  brand_id          INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  product_category  TEXT,                      -- milk | yogurt | cream | cheese | other
  region            TEXT,                      -- nullable; free text e.g. "Northeast US"
  source            TEXT NOT NULL,             -- URL, doc reference, or "manual"
  confidence        TEXT NOT NULL,             -- high | medium | low
  notes             TEXT,
  last_verified     TEXT,                      -- ISO date
  verified_by       TEXT,
  created_at        TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_plant_brands_plant ON plant_brands(plant_id);
CREATE INDEX IF NOT EXISTS idx_plant_brands_brand ON plant_brands(brand_id);

CREATE TABLE IF NOT EXISTS recalls (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  recall_number       TEXT UNIQUE,
  firm_name           TEXT,                    -- raw from openFDA (often the recalling firm, not the plant)
  firm_city           TEXT,
  firm_state          TEXT,
  plant_id            INTEGER REFERENCES plants(id) ON DELETE SET NULL,
  match_confidence    REAL,                    -- 0..1; null when unmatched
  match_method        TEXT,                    -- name | name+geo | manual | unmatched
  reason              TEXT,
  classification      TEXT,                    -- Class I | Class II | Class III
  status              TEXT,
  recall_date         TEXT,                    -- ISO date of recall initiation
  report_date         TEXT,                    -- ISO date FDA published the record
  product_description TEXT,
  raw                 TEXT,                    -- original JSON for audit
  created_at          TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_recalls_plant ON recalls(plant_id);
CREATE INDEX IF NOT EXISTS idx_recalls_date  ON recalls(recall_date);
CREATE INDEX IF NOT EXISTS idx_recalls_firm  ON recalls(firm_name);

-- Manual override table for corrections. Reviewers can pin a recall to a plant
-- (or explicitly unpin a bad fuzzy match) without losing the original data.
CREATE TABLE IF NOT EXISTS recall_overrides (
  recall_number TEXT PRIMARY KEY,
  plant_id      INTEGER REFERENCES plants(id) ON DELETE SET NULL,
  note          TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);

-- Lightweight search-query log for beta feedback. No PII (no IP, no UA),
-- just the query and the result counts so we can see what peers searched
-- for that returned nothing — that tells us which mappings to add next.
CREATE TABLE IF NOT EXISTS search_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT NOT NULL DEFAULT (datetime('now')),
  q             TEXT,
  state_filter  TEXT,
  parent_filter TEXT,
  plant_hits    INTEGER,
  brand_hits    INTEGER,
  alias_hit     INTEGER       -- 1 if the query was a direct plant-code match
);
CREATE INDEX IF NOT EXISTS idx_search_log_ts ON search_log(ts);
CREATE INDEX IF NOT EXISTS idx_search_log_q  ON search_log(q);

-- Lightweight ingest log so we can see what ran when.
CREATE TABLE IF NOT EXISTS ingest_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source       TEXT NOT NULL,                  -- ims | openfda | seeds
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  rows_in      INTEGER,
  rows_written INTEGER,
  notes        TEXT
);

-- FTS5 over the searchable surface. Triggers keep it in sync.
CREATE VIRTUAL TABLE IF NOT EXISTS plants_fts USING fts5(
  plant_code, name, city, state, parent_company,
  content='plants', content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS plants_ai AFTER INSERT ON plants BEGIN
  INSERT INTO plants_fts(rowid, plant_code, name, city, state, parent_company)
  VALUES (new.id, new.plant_code, new.name, new.city, new.state, new.parent_company);
END;
CREATE TRIGGER IF NOT EXISTS plants_ad AFTER DELETE ON plants BEGIN
  INSERT INTO plants_fts(plants_fts, rowid, plant_code, name, city, state, parent_company)
  VALUES('delete', old.id, old.plant_code, old.name, old.city, old.state, old.parent_company);
END;
CREATE TRIGGER IF NOT EXISTS plants_au AFTER UPDATE ON plants BEGIN
  INSERT INTO plants_fts(plants_fts, rowid, plant_code, name, city, state, parent_company)
  VALUES('delete', old.id, old.plant_code, old.name, old.city, old.state, old.parent_company);
  INSERT INTO plants_fts(rowid, plant_code, name, city, state, parent_company)
  VALUES (new.id, new.plant_code, new.name, new.city, new.state, new.parent_company);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS brands_fts USING fts5(
  brand_name, parent_company,
  content='brands', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS brands_ai AFTER INSERT ON brands BEGIN
  INSERT INTO brands_fts(rowid, brand_name, parent_company)
  VALUES (new.id, new.brand_name, new.parent_company);
END;
CREATE TRIGGER IF NOT EXISTS brands_ad AFTER DELETE ON brands BEGIN
  INSERT INTO brands_fts(brands_fts, rowid, brand_name, parent_company)
  VALUES('delete', old.id, old.brand_name, old.parent_company);
END;
CREATE TRIGGER IF NOT EXISTS brands_au AFTER UPDATE ON brands BEGIN
  INSERT INTO brands_fts(brands_fts, rowid, brand_name, parent_company)
  VALUES('delete', old.id, old.brand_name, old.parent_company);
  INSERT INTO brands_fts(rowid, brand_name, parent_company)
  VALUES (new.id, new.brand_name, new.parent_company);
END;
