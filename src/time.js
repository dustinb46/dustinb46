'use strict';

// Timestamps reach us in two shapes: SQLite's datetime('now') gives
// "2026-07-13 15:30:55" (UTC, no zone marker), while the ingest scripts
// write new Date().toISOString() — "2026-07-13T15:30:55.485Z". Appending
// a "Z" to the second form yields an invalid date, which is how the
// timeline came to say "NaNd ago" and the scheduler lost track of when
// it last ran. parseTs() accepts both.

function parseTs(ts) {
  if (ts === null || ts === undefined || ts === '') return null;
  let s = String(ts).trim();
  if (/^\d{4}-\d{2}-\d{2} \d/.test(s)) s = s.replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}T/.test(s) && !/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) s += 'Z';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function hoursSince(ts, now = Date.now()) {
  const d = parseTs(ts);
  return d ? (now - d.getTime()) / 3600000 : null;
}

function agoLabel(ts, now = Date.now()) {
  const h = hoursSince(ts, now);
  if (h === null) return null;
  if (h < 1) return 'just now';
  if (h < 24) return Math.floor(h) + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

module.exports = { parseTs, hoursSince, agoLabel };
