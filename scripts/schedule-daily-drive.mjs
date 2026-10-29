/**
 * Staged daily drive schedule (Hong Kong local time via Windows schtasks).
 *
 * Stages (do NOT run all at once):
 *   rescan   — 03:00  H:\ every day + weekday rotate drive (rescan/exif/missing-report only)
 *   thumb    — 03:30  enqueue thumb-hash batches (needOnly; computes quick_hash + thumbnail)
 *   embed    — 04:30  enqueue embed batches (needOnly; SQL requires existing thumbnail_cache)
 *   classify — 05:30  enqueue classify batches (needOnly; SQL requires existing embedding)
 *
 * Weekday rotate: Mon C:\  Tue D:\  Wed E:\  Thu P:\  Fri F:\ (+X:\)  Sat/Sun H:\ only
 *
 * Usage:
 *   node scripts/schedule-daily-drive.mjs --stage rescan|thumb|embed|classify [--dry-run] [--drive H:\]
 * Env: SFS_API_BASE, SFS_SPLIT_BATCH (default 500), SFS_SPLIT_MAX_JOBS (default 10)
 * Never prints secrets. Read-only on user files.
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
  1: ['C:\\'],
  2: ['D:\\'],
  3: ['E:\\'],
  4: ['P:\\'],
  5: ['F:\\', 'X:\\'],
  6: [],
  0: []
};

const STAGE_TYPES = {
  thumb: ['thumb-hash'],
  embed: ['embed'],
  classify: ['classify']
};

function stageArg() {
  const i = process.argv.indexOf('--stage');
  if (i >= 0 && process.argv[i + 1]) return String(process.argv[i + 1]).toLowerCase();
  // legacy: no --stage means old all-in-one behaviour is replaced by rescan-only
  return 'rescan';
}

const STAGE = stageArg();
if (!['rescan', 'thumb', 'embed', 'classify'].includes(STAGE)) {
  console.error('Invalid --stage. Use rescan|thumb|embed|classify');
  process.exit(2);
}

const now = new Date();
const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'tmp'), { recursive: true });
const logFile = path.join(ROOT, 'logs', `schedule-daily-drive-${STAGE}-${ymd}.log`);

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
  log('FALLBACK CLI', { cmd, pathPrefix, stage: STAGE });
  const args = ['--path-prefix', pathPrefix, '--limit', '10000'];
  if (STAGE === 'rescan') args.push('--stages', 'rescan,exif,missing-report');
  else if (STAGE === 'thumb') args.push('--stages', 'thumb', '--no-rescan');
  else if (STAGE === 'embed') args.push('--stages', 'embed', '--no-rescan');
  else if (STAGE === 'classify') args.push('--stages', 'classify', '--no-rescan');
  const r = spawnSync(cmd, args, {
    cwd: ROOT, shell: true, stdio: 'inherit', windowsHide: true, env: process.env
  });
  return r.status ?? 1;
}

function plannedDrives() {
  const override = driveArg();
  if (override) return { always: [override], rotate: [] };
  const dow = now.getDay();
  return { always: ['H:\\'], rotate: WEEKDAY_DRIVES[dow] || [] };
}

async function processRescan(token, pathPrefix) {
  const rescan = await postJson(token, '/api/daily-pipeline', {
    pathPrefix,
    skipRecycle: true,
    stages: 'rescan,exif,missing-report',
    limit: 1,
    allImages: true,
    dryRun: DRY
  });
  log('enqueued rescan', { pathPrefix, jobId: rescan.jobId });
  return { pathPrefix, rescanJobId: rescan.jobId, batches: null };
}

async function processBatches(token, pathPrefix, types) {
  const batches = await postJson(token, '/api/pipeline/enqueue-batches', {
    pathPrefix,
    batchSize: BATCH,
    maxJobsPerType: MAX_PER_TYPE,
    types,
    allImages: true,
    skipRecycle: true,
    needOnly: true,
    dryRun: DRY
  });
  const out = {
    pathPrefix,
    rescanJobId: null,
    batches: {
      submitted: (batches.submitted || []).map((x) => ({ jobId: x.jobId, type: x.type, offset: x.offset })),
      skipped: batches.skipped || [],
      activeCounts: batches.activeCounts || {}
    }
  };
  log('enqueued batches', {
    pathPrefix,
    types,
    count: out.batches.submitted.length,
    activeCounts: out.batches.activeCounts
  });
  return out;
}

async function processDrive(token, pathPrefix) {
  if (STAGE === 'rescan') return processRescan(token, pathPrefix);
  return processBatches(token, pathPrefix, STAGE_TYPES[STAGE]);
}

async function main() {
  const plan = plannedDrives();
  log('schedule-daily-drive start', {
    stage: STAGE,
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
    results.push(await processDrive(token, d));
  }
  for (const d of plan.rotate) {
    try {
      results.push(await processDrive(token, d));
    } catch (err) {
      log('rotate drive failed (continuing)', { drive: d, message: err.message, detail: err.detail || null });
    }
  }

  const summary = {
    mode: 'staged-queue',
    stage: STAGE,
    submittedAt: new Date().toISOString(),
    plan,
    results,
    publicBase: 'https://medialib2.tcghk.trade/jobs?id='
  };
  fs.writeFileSync(path.join(ROOT, 'tmp', `_last_schedule_daily_drive_${STAGE}.json`), JSON.stringify(summary, null, 2));
  console.log('SUMMARY', JSON.stringify({
    stage: STAGE,
    always: plan.always,
    rotate: plan.rotate,
    jobs: results.flatMap((r) => [
      ...(r.rescanJobId ? [{ type: 'rescan', id: r.rescanJobId, drive: r.pathPrefix }] : []),
      ...((r.batches && r.batches.submitted) || []).map((x) => ({ ...x, drive: r.pathPrefix }))
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
