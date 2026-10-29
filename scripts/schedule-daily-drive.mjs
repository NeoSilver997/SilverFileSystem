/**
 * Daily drive schedule submitter (03:00).
 * Always: H:\ rescan (+exif/missing-report) then enqueue split batches (thumb-hash/embed/classify).
 * Plus weekday rotation rescan+batches for another drive:
 *   Mon C:\  Tue D:\  Wed E:\  Thu P:\  Fri F:\ (+X:\ if present in config)
 *   Sat/Sun: H:\ only (batches refill)
 *
 * Prefers /jobs queue APIs. Falls back to CLI daily-ai-pipeline for H: if server down.
 * Never prints secrets. Read-only on user files.
 *
 * Usage: node scripts/schedule-daily-drive.mjs [--dry-run] [--drive H:]
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
dotenv.config({ quiet: true });

const API_BASE = (process.env.SFS_API_BASE || 'http://127.0.0.1:4001').replace(/\/$/, '');
const BATCH = Math.max(50, parseInt(process.env.SFS_SPLIT_BATCH || '500', 10) || 500);
const MAX_PER_TYPE = Math.max(1, parseInt(process.env.SFS_SPLIT_MAX_JOBS || '10', 10) || 10);
const DRY = process.argv.includes('--dry-run');

const WEEKDAY_DRIVES = {
  1: ['C:\\'],           // Mon
  2: ['D:\\'],           // Tue
  3: ['E:\\'],           // Wed
  4: ['P:\\'],           // Thu
  5: ['F:\\', 'X:\\'],   // Fri
  6: [],                 // Sat
  0: []                  // Sun
};

const now = new Date();
const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'tmp'), { recursive: true });
const logFile = path.join(ROOT, 'logs', `schedule-daily-drive-${ymd}.log`);

function log(msg, obj) {
  const line = `[${new Date().toISOString()}] ${msg}` + (obj !== undefined ? ' ' + JSON.stringify(obj) : '');
  console.log(line);
  try { fs.appendFileSync(logFile, line + '\n'); } catch { /* ignore */ }
}

function driveArg() {
  const i = process.argv.indexOf('--drive');
  if (i >= 0 && process.argv[i + 1]) {
    let d = process.argv[i + 1];
    if (!/[\\/]$/.test(d)) d += '\\';
    return d;
  }
  return null;
}

async function mintToken() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET missing in env');
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });
  try {
    const [users] = await conn.execute('SELECT id, username FROM users WHERE is_enabled = 1 LIMIT 1');
    if (!users[0]) throw new Error('no enabled user for JWT');
    return jwt.sign({
      id: users[0].id,
      username: users[0].username,
      can_view_photos: true,
      can_view_music: true,
      can_view_videos: true
    }, secret, { expiresIn: '12h' });
  } finally {
    await conn.end();
  }
}

async function serverReachable() {
  try {
    await fetch(API_BASE + '/api/health', { signal: AbortSignal.timeout(5000) });
    return true;
  } catch {
    try {
      await fetch(API_BASE + '/', { signal: AbortSignal.timeout(5000) });
      return true;
    } catch {
      return false;
    }
  }
}

async function postJson(token, urlPath, body) {
  const r = await fetch(API_BASE + urlPath, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000)
  });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { j = { raw: text.slice(0, 500) }; }
  if (!r.ok) {
    const err = new Error('HTTP ' + r.status + ' ' + urlPath);
    err.detail = j;
    throw err;
  }
  return j;
}

function runCliFallback(pathPrefix) {
  const cmd = path.join(ROOT, 'scripts', 'daily-ai-pipeline.cmd');
  log('FALLBACK CLI', { cmd, pathPrefix });
  const r = spawnSync(cmd, ['--path-prefix', pathPrefix, '--limit', '10000'], {
    cwd: ROOT, shell: true, stdio: 'inherit', windowsHide: true, env: process.env
  });
  return r.status ?? 1;
}

function plannedDrives() {
  const override = driveArg();
  if (override) return { always: [override], rotate: [] };
  const dow = now.getDay(); // 0 Sun .. 6 Sat
  return { always: ['H:\\'], rotate: WEEKDAY_DRIVES[dow] || [] };
}

async function processDrive(token, pathPrefix, { doRescan = true } = {}) {
  const out = { pathPrefix, rescanJobId: null, batches: null };
  if (doRescan) {
    const rescan = await postJson(token, '/api/daily-pipeline', {
      pathPrefix,
      skipRecycle: true,
      stages: 'rescan,exif,missing-report',
      limit: 1,
      allImages: true,
      dryRun: DRY
    });
    out.rescanJobId = rescan.jobId;
    log('enqueued rescan', { pathPrefix, jobId: rescan.jobId });
  }
  const batches = await postJson(token, '/api/pipeline/enqueue-batches', {
    pathPrefix,
    batchSize: BATCH,
    maxJobsPerType: MAX_PER_TYPE,
    types: ['thumb-hash', 'embed', 'classify'],
    allImages: true,
    skipRecycle: true,
    needOnly: true,
    dryRun: DRY
  });
  out.batches = {
    submitted: (batches.submitted || []).map((x) => ({ jobId: x.jobId, type: x.type, offset: x.offset })),
    skipped: batches.skipped || [],
    activeCounts: batches.activeCounts || {}
  };
  log('enqueued batches', { pathPrefix, count: out.batches.submitted.length, activeCounts: out.batches.activeCounts });
  return out;
}

async function main() {
  const plan = plannedDrives();
  log('schedule-daily-drive start', {
    apiBase: API_BASE,
    batch: BATCH,
    maxPerType: MAX_PER_TYPE,
    dryRun: DRY,
    plan
  });

  const up = await serverReachable();
  if (!up) {
    log('server unreachable — CLI fallback H:');
    process.exitCode = runCliFallback('H:\\');
    return;
  }

  const token = await mintToken();
  const results = [];
  for (const d of plan.always) {
    results.push(await processDrive(token, d, { doRescan: true }));
  }
  for (const d of plan.rotate) {
    try {
      results.push(await processDrive(token, d, { doRescan: true }));
    } catch (err) {
      log('rotate drive failed (continuing)', { drive: d, message: err.message, detail: err.detail || null });
    }
  }

  const summary = {
    mode: 'split-queue',
    submittedAt: new Date().toISOString(),
    plan,
    results,
    publicBase: 'https://medialib2.tcghk.trade/jobs?id='
  };
  fs.writeFileSync(path.join(ROOT, 'tmp', '_last_schedule_daily_drive.json'), JSON.stringify(summary, null, 2));
  console.log('SUMMARY', JSON.stringify({
    always: plan.always,
    rotate: plan.rotate,
    jobs: results.flatMap((r) => [
      ...(r.rescanJobId ? [{ type: 'rescan', id: r.rescanJobId, drive: r.pathPrefix }] : []),
      ...r.batches.submitted.map((x) => ({ ...x, drive: r.pathPrefix }))
    ])
  }));
  process.exitCode = 0;
}

main().catch((err) => {
  log('fatal', { message: err.message, detail: err.detail || null });
  try {
    process.exitCode = runCliFallback('H:\\');
  } catch (e2) {
    log('fallback failed', { message: e2.message });
    process.exitCode = 1;
  }
});
