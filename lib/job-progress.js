import dotenv from 'dotenv';
import { fileURLToPath as __fu } from 'url';
import { dirname as __dn, join as __jn } from 'path';
dotenv.config({ path: __jn(__dn(__fu(import.meta.url)), '..', '.env'), quiet: true });
/**
 * In-process job queue with progress + persisted results for review.
 * Jobs auto-start (FIFO). Concurrency: JOB_MAX_CONCURRENT (default 1, cap 16).
 * Optional JOB_MAX_PER_TYPE limits how many of one type run at once (0 = unlimited).
 * No pending_review / Approve gate.
 * Store: data/job-queue.json
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = path.join(__dirname, '..', 'data', 'job-queue.json');
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CONCURRENT = Math.max(1, Math.min(16, parseInt(process.env.JOB_MAX_CONCURRENT || '1', 10) || 1));
/** Optional per-type cap so thumb-hash / embed / classify can share the pool fairly. 0 = no per-type limit. */
const MAX_PER_TYPE = Math.max(0, Math.min(16, parseInt(process.env.JOB_MAX_PER_TYPE || '0', 10) || 0));

/** @type {Map<string, object>} */
const jobs = new Map();
/** @type {((job: object) => Promise<any>) | null} */
let runner = null;
/** @type {Set<string>} */
const runningIds = new Set();
let persistTimer = null;
let loaded = false;

function nowIso() {
  return new Date().toISOString();
}

function clampPercent(done, total) {
  if (!total || total <= 0) return done > 0 ? 100 : 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    if (fs.existsSync(STORE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
      const list = Array.isArray(raw?.jobs) ? raw.jobs : [];
      for (const j of list) {
        if (!j?.id) continue;
        if (j.status === 'running' || j.status === 'queued') {
          j.status = 'error';
          j.error = j.error || 'Interrupted by server restart';
          j.message = j.message || 'Interrupted by server restart';
          j.finishedAt = nowIso();
          j.updatedAt = nowIso();
        }
        jobs.set(j.id, j);
      }
    }
  } catch (err) {
    console.error('[job-progress] load failed:', err.message);
  }
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      ensureLoaded();
      const payload = {
        version: 1,
        jobs: [...jobs.values()].map((j) => {
          const { _cancelRequested, ...rest } = j;
          return rest;
        })
      };
      fs.writeFileSync(STORE_PATH, JSON.stringify(payload, null, 2), 'utf8');
    } catch (err) {
      console.error('[job-progress] persist failed:', err.message);
    }
  }, 200);
}

function publicView(job) {
  if (!job) return null;
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    done: job.done,
    total: job.total,
    percent: clampPercent(job.done, job.total),
    message: job.message,
    currentItem: job.currentItem,
    error: job.error,
    result: job.result,
    meta: job.meta,
    createdBy: job.createdBy,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt
  };
}

export function cleanupExpired(now = Date.now()) {
  ensureLoaded();
  let changed = false;
  for (const [id, job] of jobs) {
    if (job.status === 'running' || job.status === 'queued') continue;
    const base = Date.parse(job.updatedAt || job.finishedAt || job.createdAt || 0) || 0;
    if (base && now - base > DEFAULT_TTL_MS) {
      jobs.delete(id);
      changed = true;
    }
  }
  if (changed) schedulePersist();
}

export function setRunner(fn) {
  runner = fn;
}

export function createJob({ type, total = 0, meta = {}, params = {}, createdBy = null } = {}) {
  ensureLoaded();
  cleanupExpired();
  const id = crypto.randomBytes(8).toString('hex');
  const job = {
    id,
    type: type || 'job',
    status: 'queued',
    done: 0,
    total: Number(total) || 0,
    message: 'Queued',
    currentItem: null,
    error: null,
    result: null,
    meta: meta || {},
    params: params || {},
    createdBy,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    startedAt: null,
    finishedAt: null,
    _cancelRequested: false
  };
  jobs.set(id, job);
  schedulePersist();
  setImmediate(() => pump());
  return id;
}

export function update(jobId, patch = {}) {
  ensureLoaded();
  const job = jobs.get(jobId);
  if (!job) return null;
  if (patch.total != null) job.total = Number(patch.total) || 0;
  if (patch.done != null) job.done = Number(patch.done) || 0;
  if (patch.status) job.status = patch.status;
  if (patch.message != null) job.message = String(patch.message);
  if (patch.currentItem !== undefined) job.currentItem = patch.currentItem;
  if (patch.error != null) job.error = String(patch.error);
  if (patch.result !== undefined) job.result = patch.result;
  if (patch.meta) job.meta = { ...(job.meta || {}), ...patch.meta };
  job.updatedAt = nowIso();
  schedulePersist();
  return publicView(job);
}

export function get(jobId) {
  ensureLoaded();
  cleanupExpired();
  return publicView(jobs.get(jobId));
}

export function getRaw(jobId) {
  ensureLoaded();
  return jobs.get(jobId) || null;
}

export function list({ status, type, limit = 100, maxAgeDays = null, includeOlder = false } = {}) {
  ensureLoaded();
  cleanupExpired();
  let arr = [...jobs.values()];
  if (status) {
    const set = new Set(String(status).split(',').map((s) => s.trim()).filter(Boolean));
    arr = arr.filter((j) => set.has(j.status));
  }
  if (type) arr = arr.filter((j) => j.type === type);
  const days = maxAgeDays == null || maxAgeDays === '' ? null : Number(maxAgeDays);
  if (!includeOlder && Number.isFinite(days) && days > 0) {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    arr = arr.filter((j) => {
      // Keep active jobs even if old; hide finished/cancelled older than cutoff
      if (j.status === 'queued' || j.status === 'running') return true;
      const t = Date.parse(j.finishedAt || j.updatedAt || j.createdAt || 0) || 0;
      return t >= cutoff;
    });
  }
  arr.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return arr.slice(0, Math.min(500, Math.max(1, Number(limit) || 100))).map(publicView);
}

function releaseRunning(jobId) {
  runningIds.delete(jobId);
}

export function fail(jobId, error, message) {
  ensureLoaded();
  const job = jobs.get(jobId);
  if (!job) return null;
  job.status = 'error';
  job.error = String(error || 'Job failed');
  job.message = message || job.error;
  job.finishedAt = nowIso();
  job.updatedAt = nowIso();
  releaseRunning(jobId);
  schedulePersist();
  setImmediate(() => pump());
  return publicView(job);
}

export function complete(jobId, result, message) {
  ensureLoaded();
  const job = jobs.get(jobId);
  if (!job) return null;
  job.status = 'done';
  if (job.total) job.done = job.total;
  job.result = result ?? null;
  job.message = message || 'Done';
  job.currentItem = null;
  job.error = null;
  job.finishedAt = nowIso();
  job.updatedAt = nowIso();
  releaseRunning(jobId);
  schedulePersist();
  setImmediate(() => pump());
  return publicView(job);
}

export function cancel(jobId, { reason = 'Cancelled' } = {}) {
  ensureLoaded();
  const job = jobs.get(jobId);
  if (!job) return null;
  if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
    const err = new Error(`Cannot cancel job in status ${job.status}`);
    err.statusCode = 409;
    throw err;
  }
  job._cancelRequested = true;
  job.status = 'cancelled';
  job.message = reason;
  job.error = reason;
  job.finishedAt = nowIso();
  job.updatedAt = nowIso();
  releaseRunning(jobId);
  schedulePersist();
  setImmediate(() => pump());
  return publicView(job);
}

export function isCancelled(jobId) {
  ensureLoaded();
  const job = jobs.get(jobId);
  return !!(job && (job.status === 'cancelled' || job._cancelRequested));
}

async function runOne(next) {
  runningIds.add(next.id);
  next.status = 'running';
  next.startedAt = nowIso();
  next.message = 'Running…';
  next.done = 0;
  next.error = null;
  next.updatedAt = nowIso();
  schedulePersist();

  try {
    await runner(next);
    const cur = jobs.get(next.id);
    if (cur && cur.status === 'running') {
      complete(next.id, cur.result, cur.message || 'Done');
    }
  } catch (err) {
    const cur = jobs.get(next.id);
    if (cur && cur.status === 'running') {
      fail(next.id, err.message || String(err));
    }
  } finally {
    releaseRunning(next.id);
    setImmediate(() => pump());
  }
}

function runningTypeCounts() {
  const counts = Object.create(null);
  for (const id of runningIds) {
    const j = jobs.get(id);
    if (!j) continue;
    const t = j.type || 'job';
    counts[t] = (counts[t] || 0) + 1;
  }
  return counts;
}

async function pump() {
  if (!runner) return;
  ensureLoaded();
  while (runningIds.size < MAX_CONCURRENT) {
    const typeCounts = runningTypeCounts();
    const next = [...jobs.values()]
      .filter((j) => j.status === 'queued')
      .filter((j) => {
        if (!MAX_PER_TYPE) return true;
        const t = j.type || 'job';
        return (typeCounts[t] || 0) < MAX_PER_TYPE;
      })
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
    if (!next) break;
    const t = next.type || 'job';
    typeCounts[t] = (typeCounts[t] || 0) + 1;
    void runOne(next);
    if (runningIds.size >= MAX_CONCURRENT) break;
  }
}

export function getConcurrency() {
  return { max: MAX_CONCURRENT, maxPerType: MAX_PER_TYPE || null, running: runningIds.size, byType: runningTypeCounts() };
}

export default {
  createJob, update, get, getRaw, list, fail, complete, cancel, isCancelled, setRunner, cleanupExpired, getConcurrency
};

