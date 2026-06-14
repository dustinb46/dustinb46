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

console.log(`[init-db] applied schema to ${DB_PATH}`);
db.close();
