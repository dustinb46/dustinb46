#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const RESET = process.argv.includes('--reset');
const DB_PATH = process.env.PLANT_TRACK_DB
  || path.join(__dirname, '..', 'db', 'plant_track.db');
const SCHEMA_PATH = path.join(__dirname, '..', 'db', 'schema.sql');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

if (RESET && fs.existsSync(DB_PATH)) {
  for (const ext of ['', '-journal', '-wal', '-shm']) {
    const p = DB_PATH + ext;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  console.log(`[init-db] reset: removed ${DB_PATH}`);
}

const db = new Database(DB_PATH);
const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
db.exec(schema);

// Defensive column adds for live databases that predate later schema
// changes. SQLite can't ADD COLUMN IF NOT EXISTS, so we probe first.
function ensureColumn(table, column, type) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all()
    .some(c => c.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    console.log(`[init-db] added ${table}.${column}`);
  }
}
ensureColumn('plants', 'lat', 'REAL');
ensureColumn('plants', 'lon', 'REAL');
ensureColumn('plants', 'geocoded_at', 'TEXT');
ensureColumn('recalls', 'event_id', 'TEXT');
// Index created here (not in schema.sql) so it runs after the column is
// guaranteed to exist on pre-existing databases.
db.exec(`CREATE INDEX IF NOT EXISTS idx_recalls_event ON recalls(event_id)`);

// Backfill event_id from the stored raw openFDA JSON for rows that don't
// have it yet (existing data predating the column). json_extract is
// built into SQLite. Cheap and idempotent.
try {
  const info = db.prepare(
    `UPDATE recalls
        SET event_id = json_extract(raw, '$.event_id')
      WHERE event_id IS NULL
        AND raw IS NOT NULL
        AND json_valid(raw)
        AND json_extract(raw, '$.event_id') IS NOT NULL`
  ).run();
  if (info.changes) console.log(`[init-db] backfilled event_id on ${info.changes} recalls`);
} catch (e) {
  console.warn(`[init-db] event_id backfill skipped: ${e.message}`);
}

console.log(`[init-db] applied schema to ${DB_PATH}`);
db.close();
