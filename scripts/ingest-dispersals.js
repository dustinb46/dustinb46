#!/usr/bin/env node
// Load herd dispersal listings from data/dispersals/*.csv into the
// dispersals table. Every CSV in the folder is loaded, so each scrape or
// curation round can ship its own file and git keeps the audit trail.
//
// Runs in prestart, so it is deliberately non-fatal: a missing folder, an
// empty file or a bad row is logged and skipped, and never blocks a boot.
// Safe to re-run: rows upsert on a fingerprint of date + headline + source.
//
// The CSVs are the whole truth, the same rule as the news CSV: a row
// taken out of the files is taken off the site on the next load. That
// clean-up is skipped if any file failed to parse, so a broken file can
// never empty the table.

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { parseDispersalRow } = require('../src/records');

const DIR = path.join(__dirname, '..', 'data', 'dispersals');

function main() {
  // A missing folder means the files were never shipped (an old image, a
  // bad checkout), not that every listing was withdrawn: change nothing.
  if (!fs.existsSync(DIR)) {
    console.log('[dispersals] no data/dispersals folder; nothing to load');
    return;
  }
  const files = fs.readdirSync(DIR).filter(f => f.toLowerCase().endsWith('.csv')).sort();

  const { db } = require('../src/db');
  const runStarted = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO dispersals (event_date, headline, head_count, herd_type, city, county,
                            state, lat, lon, auctioneer, source_url, source_name,
                            added_by, fingerprint)
    VALUES (@event_date, @headline, @head_count, @herd_type, @city, @county,
            @state, @lat, @lon, @auctioneer, @source_url, @source_name,
            @added_by, @fingerprint)
    ON CONFLICT(fingerprint) DO UPDATE SET
      head_count = excluded.head_count,
      herd_type = excluded.herd_type,
      city = excluded.city,
      county = excluded.county,
      state = excluded.state,
      lat = excluded.lat,
      lon = excluded.lon,
      auctioneer = excluded.auctioneer,
      source_name = excluded.source_name,
      added_by = excluded.added_by
  `);

  let rowsIn = 0, written = 0, skipped = 0, removed = 0, parseFailed = false;
  const seen = new Set();
  for (const file of files) {
    let rows;
    try {
      rows = parse(fs.readFileSync(path.join(DIR, file), 'utf8'),
        { columns: true, skip_empty_lines: true, trim: true });
    } catch (e) {
      parseFailed = true;
      console.warn(`[dispersals] ${file}: could not parse (${e.message}); skipped`);
      continue;
    }
    const txn = db.transaction(() => {
      rows.forEach((row, i) => {
        rowsIn++;
        const parsed = parseDispersalRow(row);
        if (!parsed.ok) {
          skipped++;
          console.warn(`[dispersals] ${file} row ${i + 2}: ${parsed.reason}; skipped`);
          return;
        }
        upsert.run(parsed.value);
        seen.add(parsed.value.fingerprint);
        written++;
      });
    });
    txn();
  }

  if (parseFailed) {
    console.warn('[dispersals] a file failed to parse; not removing any rows this run');
  } else {
    const drop = db.prepare(`DELETE FROM dispersals WHERE fingerprint = ?`);
    const stale = db.prepare(`SELECT fingerprint FROM dispersals`).all()
      .map(r => r.fingerprint).filter(f => !seen.has(f));
    db.transaction(() => { for (const f of stale) drop.run(f); })();
    removed = stale.length;
  }

  // Runs on every boot, so only log a run when something changed.
  if (rowsIn || removed) {
    db.prepare(`
      INSERT INTO ingest_runs (source, started_at, finished_at, rows_in, rows_written, notes)
      VALUES ('dispersals', ?, ?, ?, ?, ?)
    `).run(runStarted, new Date().toISOString(), rowsIn, written,
      `files=${files.length} skipped=${skipped} removed=${removed}`);
  }
  console.log(`[dispersals] files=${files.length} rows=${rowsIn} written=${written} skipped=${skipped} removed=${removed}`);
}

try {
  main();
} catch (e) {
  console.warn(`[dispersals] load skipped: ${e.message}`);
}
