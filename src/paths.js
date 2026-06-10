const path = require('path');
const fs = require('fs');

// Where IMS PDFs are stored. These must live on the persistent volume in
// production, otherwise they vanish on redeploy. We derive the directory
// from the DB location (the volume) when available.
function imsDir() {
  if (process.env.IMS_DIR) return process.env.IMS_DIR;
  if (process.env.PLANT_TRACK_DB) {
    return path.join(path.dirname(process.env.PLANT_TRACK_DB), 'ims');
  }
  return path.join(__dirname, '..', 'data', 'ims');
}

function imsPdfPath() {
  return process.env.IMS_PDF_PATH || path.join(imsDir(), 'ims-list.pdf');
}

function ensureImsDir() {
  const dir = imsDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { imsDir, imsPdfPath, ensureImsDir };
