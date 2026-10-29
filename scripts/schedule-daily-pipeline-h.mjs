/**
 * Scheduled H:-only daily AI pipeline submitter.
 * Prefer POST /api/daily-pipeline so work appears on /jobs.
 * Fallback: scripts/daily-ai-pipeline.cmd --path-prefix H:\ if server unreachable.
 * Never prints secrets. Read-only on user files.
 *
 * Usage: node scripts/schedule-daily-pipeline-h.mjs
 * Env overrides (optional): SFS_DAILY_LIMIT, SFS_DAILY_STAGES, SFS_API_BASE
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
const LIMIT = Math.max(1, parseInt(process.env.SFS_DAILY_LIMIT || '10000', 10) || 10000);
const STAGES = process.env.SFS_DAILY_STAGES || 'rescan,exif,thumb,embed,classify,missing-report';
const PATH_PREFIX = 'H:\\';
const DRY = process.argv.includes('--dry-run');
const BODY = {
  limit: LIMIT,
  pathPrefix: PATH_PREFIX,
  skipRecycle: true,
  stages: STAGES,
  dryRun: DRY
};

const now = new Date();
const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'tmp'), { recursive: true });
const logFile = path.join(ROOT, 'logs', `schedule-daily-h-${ymd}.log`);

function log(msg, obj) {
  const line = `[${new Date().toISOString()}] ${msg}` + (obj !== undefined ? ' ' + JSON.stringify(obj) : '');
  console.log(line);
  try { fs.appendFileSync(logFile, line + '\n'); } catch { /* ignore */ }
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
    const r = await fetch(API_BASE + '/api/health', { signal: AbortSignal.timeout(5000) });
    // any HTTP response means port is up; 404 also fine
    return true;
  } catch {
    try {
      const r = await fetch(API_BASE + '/', { signal: AbortSignal.timeout(5000) });
      return true;
    } catch {
      return false;
    }
  }
}

async function submitJob(token) {
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const r = await fetch(API_BASE + '/api/daily-pipeline', {
    method: 'POST',
    headers,
    body: JSON.stringify(BODY),
    signal: AbortSignal.timeout(30000)
  });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { j = { raw: text.slice(0, 500) }; }
  if (!r.ok || !j.jobId) {
    const err = new Error('enqueue failed HTTP ' + r.status);
    err.detail = j;
    throw err;
  }
  return j;
}

function runCliFallback() {
  const cmd = path.join(ROOT, 'scripts', 'daily-ai-pipeline.cmd');
  log('FALLBACK CLI start', { cmd, args: ['--path-prefix', 'H:\\', '--limit', String(LIMIT)] });
  const r = spawnSync(cmd, ['--path-prefix', 'H:\\', '--limit', String(LIMIT)], {
    cwd: ROOT,
    shell: true,
    stdio: 'inherit',
    windowsHide: true,
    env: process.env
  });
  log('FALLBACK CLI exit', { status: r.status, signal: r.signal });
  return r.status ?? 1;
}

async function main() {
  log('schedule-daily-pipeline-h start', {
    apiBase: API_BASE,
    pathPrefix: PATH_PREFIX,
    limit: LIMIT,
    stages: STAGES,
    skipRecycle: true
  });

  const up = await serverReachable();
  if (!up) {
    log('server unreachable — using CLI fallback');
    process.exitCode = runCliFallback();
    return;
  }

  try {
    const token = await mintToken();
    const j = await submitJob(token);
    const out = {
      mode: 'job-queue',
      jobId: j.jobId,
      status: j.status,
      reviewUrl: j.reviewUrl || ('/jobs?id=' + j.jobId),
      publicUrl: 'https://medialib2.tcghk.trade/jobs?id=' + j.jobId,
      body: BODY,
      submittedAt: new Date().toISOString()
    };
    fs.writeFileSync(path.join(ROOT, 'tmp', '_last_schedule_daily_h.json'), JSON.stringify(out, null, 2));
    log('enqueued daily-pipeline', { jobId: j.jobId, status: j.status, url: out.publicUrl });
    console.log('JOB', j.jobId);
    console.log('URL', out.publicUrl);
    process.exitCode = 0;
  } catch (err) {
    log('enqueue error — CLI fallback', { message: err.message, detail: err.detail || null });
    process.exitCode = runCliFallback();
  }
}

main().catch((err) => {
  log('fatal', { message: err.message });
  try {
    process.exitCode = runCliFallback();
  } catch (e2) {
    log('fallback also failed', { message: e2.message });
    process.exitCode = 1;
  }
});
