const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.PLANT_TRACK_DB
  || path.join(__dirname, '..', 'db', 'plant_track.db');

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

module.exports = { db, DB_PATH };
