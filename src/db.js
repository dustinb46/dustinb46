const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.PLANT_TRACK_DB
  || path.join(__dirname, '..', 'db', 'plant_track.db');

// A missing parent directory is the signature of a production volume that
// failed to mount: PLANT_TRACK_DB points at /data/... but nothing is
// mounted there. better-sqlite3's own error for this ("directory does not
// exist") doesn't say which directory or why it matters, and the container
// then crash-loops until the restart policy gives up. We refuse to create
// the directory ourselves — on an unmounted volume that would silently
// write to ephemeral container disk and lose the data on the next deploy —
// but we do say exactly what to check.
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) {
  throw new Error(
    `Cannot open the database: directory ${dir} does not exist.\n` +
    `PLANT_TRACK_DB is set to ${DB_PATH}, so a persistent volume is expected ` +
    `at ${dir}. Check that the volume is still attached to this service and ` +
    `mounted at that path. Not creating it here on purpose: without the ` +
    `volume, anything written would be lost on the next deploy.`
  );
}

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

module.exports = { db, DB_PATH };
