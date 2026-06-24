'use strict';

// Lightweight in-process scheduler for periodic background jobs.
//
// We don't use Railway's cron-as-a-service to avoid a second service
// slot and to keep state in our own DB. Every CHECK_INTERVAL_HOURS,
// each job decides for itself whether to run by comparing the last
// successful ingest_runs.finished_at to its desired cadence. That
// pattern self-heals from container restarts and missed cycles —
// the job either ran recently and skips, or it's overdue and runs.

const { spawn } = require('child_process');
const path = require('path');
const { db } = require('./db');

const CHECK_INTERVAL_HOURS = parseInt(process.env.SCHEDULER_CHECK_INTERVAL_HOURS || '6', 10);
const STARTUP_DELAY_MS = parseInt(process.env.SCHEDULER_STARTUP_DELAY_MS || (5 * 60 * 1000), 10);

const JOBS = [
  {
    name: 'recalls-sync',
    source: 'openfda',
    intervalHours: 24,
    script: 'scripts/sync-recalls.js',
    env: { RECALL_MAX_PAGES: '20' },
    // After a fresh recall pull, re-harvest plant codes printed in the
    // recall notices and pin them (match_method='plt_code'). Runs only
    // when the sync actually fired, so it stays in step with new data.
    then: {
      script: 'scripts/harvest-recall-codes.js',
      env: { APPLY: '1' },
    },
  },
];

function hoursSinceLast(source) {
  const row = db.prepare(
    `SELECT finished_at FROM ingest_runs
     WHERE source = ? AND finished_at IS NOT NULL
     ORDER BY finished_at DESC LIMIT 1`
  ).get(source);
  if (!row) return Infinity;
  return (Date.now() - new Date(row.finished_at + 'Z').getTime()) / 3600000;
}

function runScript(script, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [script], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, ...extraEnv },
    });
    let tail = '';
    const grab = (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const l of lines) if (l.trim()) tail = l;     // keep the last non-empty line
    };
    child.stdout.on('data', grab);
    child.stderr.on('data', grab);
    child.on('close', code => {
      if (code === 0) resolve(tail);
      else reject(new Error(`exit ${code}: ${tail}`));
    });
    child.on('error', reject);
  });
}

async function tickOne(job) {
  const elapsed = hoursSinceLast(job.source);
  if (elapsed < job.intervalHours) {
    console.log(`[scheduler] ${job.name}: ${elapsed.toFixed(1)}h since last (need ${job.intervalHours}h), skip`);
    return;
  }
  console.log(`[scheduler] ${job.name}: ${elapsed === Infinity ? 'no prior run' : elapsed.toFixed(1) + 'h since last'}, starting...`);
  try {
    const tail = await runScript(job.script, job.env || {});
    console.log(`[scheduler] ${job.name}: done. ${tail}`);
    // Chained follow-up (e.g. harvest plant codes after a recall sync).
    // Only runs if the primary job succeeded, so it tracks fresh data.
    if (job.then) {
      try {
        const tail2 = await runScript(job.then.script, job.then.env || {});
        console.log(`[scheduler] ${job.name} > ${job.then.script}: done. ${tail2}`);
      } catch (err2) {
        console.error(`[scheduler] ${job.name} > ${job.then.script}: FAILED. ${err2.message}`);
      }
    }
  } catch (err) {
    console.error(`[scheduler] ${job.name}: FAILED. ${err.message}`);
  }
}

async function tick() {
  for (const job of JOBS) await tickOne(job);
}

function start() {
  if (process.env.AUTO_SYNC === '0') {
    console.log('[scheduler] disabled via AUTO_SYNC=0');
    return;
  }
  console.log(`[scheduler] enabled — first check in ${Math.round(STARTUP_DELAY_MS / 1000)}s, then every ${CHECK_INTERVAL_HOURS}h`);
  setTimeout(tick, STARTUP_DELAY_MS);
  setInterval(tick, CHECK_INTERVAL_HOURS * 3600 * 1000);
}

module.exports = { start, tick, hoursSinceLast };
