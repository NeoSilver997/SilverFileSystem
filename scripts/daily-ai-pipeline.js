#!/usr/bin/env node
/**
 * Daily AI pipeline: thumbnail -> embed -> classify for the latest N image files.
 * Idempotent: each step only runs for files missing that step.
 * Read-only on user files (never moves / deletes / marks deleted). Offline drive roots skipped.
 *
 * Usage: node scripts/daily-ai-pipeline.js [--limit 10000] [--dry-run] [--no-rescan] [--all-images] [--print-sql]
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import sharp from 'sharp';
import heicConvert from 'heic-convert';
import { DatabaseManager } from '../lib/database.js';
import { EmbeddingClient, ensureEmbeddingServer, stopEmbeddingServer } from '../lib/embedding-client.js';
import { EmbedClassifier } from '../lib/embed-classifier.js';
import { partitionByDriveOnline } from '../lib/drive-online.js';
import { loadConfig } from '../lib/utils.js';
import { ensureDateSourceColumn, extractPhotoMetaForFiles } from '../lib/photo-meta-extract.js';
import { rescanFolderRecursive } from '../lib/folder-rescan.js';
import { isDriveRootAccessibleAsync } from '../lib/drive-online.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
dotenv.config({ quiet: true });

// ---- args ----
const argv = process.argv.slice(2);
const argVal = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const LIMIT = Math.max(1, parseInt(argVal('--limit', '10000'), 10) || 10000);
const DRY = argv.includes('--dry-run');
const NO_RESCAN = argv.includes('--no-rescan');
const THUMB_MAX = 400;
const IMG_EXTS = ['jpg','jpeg','png','webp','heic','heif','avif'];
const ALL_IMAGES = argv.includes('--all-images');

// Camera / screenshot filter (config/daily-pipeline-filter.json)
function buildImageFilterSql(conn) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'daily-pipeline-filter.json'), 'utf8').replace(/^\uFEFF/, '')); } catch { cfg = {}; }
  const q = (v) => conn.escape(v);
  const like = (col, kw) => `${col} LIKE ${q('%' + kw + '%')}`;
  const fullPath = "CONCAT(COALESCE(ft.folder_id,''), CHAR(92), sf.name)";
  const shot = (cfg.screenshotKeywords || []).map(k => like(fullPath, k));
  const cam = (cfg.cameraPathKeywords || []).map(k => like('ft.folder_id', k));
  if (cfg.cameraNameRegex) cam.push(`sf.name REGEXP ${q(cfg.cameraNameRegex)}`);
  if (cfg.useExifCamera !== false) cam.push("EXISTS (SELECT 1 FROM photo_metadata pm WHERE pm.file_id = sf.id AND COALESCE(pm.camera_model, pm.camera_make, '') <> '')");
  const shotSql = shot.length ? '(' + shot.join(' OR ') + ')' : '0';
  const camSql = cam.length ? '(' + cam.join(' OR ') + ')' : '0';
  const days = Number.isFinite(+cfg.maxFutureDays) ? +cfg.maxFutureDays : 1;
  return {
    kindSql: `CASE WHEN ${shotSql} THEN 'screenshot' WHEN ${camSql} THEN 'camera' ELSE 'other' END`,
    whereSql: (ALL_IMAGES ? '' : `AND (${shotSql} OR ${camSql})`) + ` AND sf.mtime <= NOW() + INTERVAL ${days} DAY`,
  };
}

// ---- logging ----
const now = new Date();
const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'tmp'), { recursive: true });
const logFile = path.join(ROOT, 'logs', `daily-ai-pipeline-${ymd}.log`);
function log(msg, obj) {
  const line = `[${new Date().toISOString()}] ${msg}${obj ? ' ' + JSON.stringify(obj) : ''}`;
  console.log(line);
  fs.appendFileSync(logFile, line + '\n');
}

// ---- lock ----
const lockFile = path.join(ROOT, 'tmp', 'daily-ai-pipeline.lock');
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
if (fs.existsSync(lockFile)) {
  let pid = 0;
  try { pid = parseInt(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid, 10); } catch {}
  if (pid && pidAlive(pid)) { log('Another run is active, exiting', { pid }); process.exit(3); }
  log('Removing stale lock', { pid });
}
fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, started: now.toISOString() }));
const releaseLock = () => { try { const j = JSON.parse(fs.readFileSync(lockFile, 'utf8')); if (j.pid === process.pid) fs.unlinkSync(lockFile); } catch {} };
process.on('exit', releaseLock);
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

function computeQuickHash(filePath) {
  try {
    const size = fs.statSync(filePath).size;
    const fd = fs.openSync(filePath, 'r');
    const n = Math.min(65536, size);
    const head = Buffer.alloc(n), tail = Buffer.alloc(n);
    fs.readSync(fd, head, 0, n, 0);
    if (size > n) fs.readSync(fd, tail, 0, n, size - n);
    fs.closeSync(fd);
    return crypto.createHash('md5').update(head).update(tail).update(String(size)).digest('hex');
  } catch { return null; }
}

async function makeThumb(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  let input = filePath;
  if (ext === '.heic' || ext === '.heif') {
    input = Buffer.from(await heicConvert({ buffer: fs.readFileSync(filePath), format: 'JPEG', quality: 0.9 }));
  }
  return sharp(input, { failOn: 'none' }).rotate()
    .resize({ width: THUMB_MAX, height: THUMB_MAX, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 75 }).toBuffer();
}

function bufToFloats(raw, dims) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const n = dims || Math.floor(buf.byteLength / 4);
  return Array.from(new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + n * 4)));
}

const t0 = Date.now();
const summary = { limit: LIMIT, dryRun: DRY, rescan: [], selected: 0, skippedOffline: 0,
  thumb: { need: 0, ok: 0, fail: 0, missingFile: 0 },
  embed: { need: 0, ok: 0, fail: 0, noThumb: 0 },
  classify: { need: 0, ok: 0, fail: 0 }, failSamples: [] };
const fail = (stage, f, err) => { if (summary.failSamples.length < 20) summary.failSamples.push({ stage, id: f.id, name: f.name, error: String(err?.message || err).slice(0, 200) }); };

let db;
try {
  log(`Start daily AI pipeline limit=${LIMIT} dryRun=${DRY}`);
  const config = loadConfig();
  db = new DatabaseManager(config.database);
  await db.connect();
  const conn = db.connection;
  const model = process.env.EMBEDDING_MODEL || 'embeddinggemma-2';

  // ---- Step 0: read-only rescan of configured folders ----
  const cfgPath = path.join(ROOT, 'config', 'daily-refresh-folders.json');
  let folders = [];
  try { folders = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).folders || []; } catch (e) { log('No/invalid config/daily-refresh-folders.json', { error: e.message }); }
  if (NO_RESCAN) folders = [];
  for (const folder of folders) {
    const t = Date.now();
    if (!(await isDriveRootAccessibleAsync(folder, 3000))) { log('Rescan skip (drive offline)', { folder }); summary.rescan.push({ folder, skipped: 'drive offline' }); continue; }
    if (!fs.existsSync(folder)) { log('Rescan skip (folder not found)', { folder }); summary.rescan.push({ folder, skipped: 'not found' }); continue; }
    if (DRY) { summary.rescan.push({ folder, skipped: 'dry-run' }); log('Rescan (dry-run, not scanned)', { folder }); continue; }
    try {
      const r = await rescanFolderRecursive(db, folder, { removeMissing: false });
      r.sec = Math.round((Date.now() - t) / 1000);
      summary.rescan.push({ folder, ...r });
      log('Rescan done', { folder, ...r });
    } catch (e) { summary.rescan.push({ folder, error: e.message }); log('Rescan error', { folder, error: e.message }); }
  }

  // Latest images by mtime (fetch extra so offline-drive rows can be dropped)
  const flt = buildImageFilterSql(conn);
  const selectSql = `
    SELECT sf.id, sf.name, sf.size, sf.hash, sf.md5, sf.quick_hash, sf.mtime, sf.ctime, ${flt.kindSql} AS kind,
           CONCAT(TRIM(TRAILING CHAR(92) FROM COALESCE(ft.folder_id,'')), CHAR(92), sf.name) AS path
    FROM scanned_files sf
    JOIN folder_tree ft ON ft.id = sf.folder_id_int
    WHERE LOWER(COALESCE(sf.extension,'')) IN (${IMG_EXTS.map(e => `'${e}'`).join(',')})
      ${flt.whereSql}
    ORDER BY sf.mtime DESC, sf.id DESC
    LIMIT ${LIMIT * 2}`;
  if (argv.includes('--print-sql')) console.log(selectSql);
  const [rows] = await conn.query(selectSql);
  const { online, skippedOffline } = await partitionByDriveOnline(rows, { log: (m) => log(m) });
  const files = online.slice(0, LIMIT);
  summary.selected = files.length;
  summary.kinds = files.reduce((a, f) => (a[f.kind] = (a[f.kind] || 0) + 1, a), {});
  summary.samplePaths = files.filter((_, i) => i % Math.max(1, Math.floor(files.length / 5)) === 0).slice(0, 5).map(f => f.path);
  summary.newest = files[0]?.mtime; summary.oldest = files[files.length - 1]?.mtime;
  summary.skippedOffline = skippedOffline.length;
  log('Selected files', { selected: files.length, offlineSkipped: skippedOffline.length,
    newest: files[0]?.mtime, oldest: files[files.length - 1]?.mtime });
  if (!files.length) throw Object.assign(new Error('no files'), { benign: true });

  const ids = files.map(f => f.id);
  const inList = async (sql, params = []) => {
    const out = new Set();
    for (let i = 0; i < ids.length; i += 1000) {
      const chunk = ids.slice(i, i + 1000);
      const [r] = await conn.query(sql.replace('__IDS__', chunk.map(() => '?').join(',')), [...params, ...chunk]);
      r.forEach(x => out.add(x.file_id));
    }
    return out;
  };

  // ---- Step 0b: EXIF / photo_metadata (date fallback: created -> mtime) ----
  {
    const hasMeta = await inList('SELECT DISTINCT file_id FROM photo_metadata WHERE file_id IN (__IDS__)');
    const needMeta = files.filter(f => !hasMeta.has(f.id));
    summary.exif = { need: needMeta.length };
    log('Step 0b exif: need', { need: needMeta.length });
    if (!DRY && needMeta.length) {
      await ensureDateSourceColumn(conn);
      Object.assign(summary.exif, await extractPhotoMetaForFiles(db, needMeta, { concurrency: 8, onFail: (s, f, e) => fail('exif-' + s, f, e) }));
      log('Step 0b exif done', summary.exif);
    }
  }

  // ---- Step 1: thumbnails ----
  const needThumb = [];
  for (const f of files) {
    const t = await db.getThumbnailForScannedFile(f);
    if (!t) needThumb.push(f);
  }
  summary.thumb.need = needThumb.length;
  log('Step 1 thumbs: need', { need: needThumb.length });
  if (!DRY) {
    let i = 0;
    for (const f of needThumb) {
      i++;
      try {
        if (!fs.existsSync(f.path)) { summary.thumb.missingFile++; continue; } // do NOT mark deleted
        let key = f.hash || f.md5 || f.quick_hash;
        if (!key) {
          key = computeQuickHash(f.path);
          if (!key) throw new Error('quick hash failed');
          await conn.execute('UPDATE scanned_files SET quick_hash = ? WHERE id = ? AND quick_hash IS NULL', [key, f.id]);
          f.quick_hash = key;
        }
        const buf = await makeThumb(f.path);
        await db.saveThumbnail(key, f.size, 'image', buf, 'image/jpeg');
        summary.thumb.ok++;
      } catch (e) { summary.thumb.fail++; fail('thumb', f, e); }
      if (i % 500 === 0) log('thumb progress', { done: i, total: needThumb.length, ok: summary.thumb.ok, fail: summary.thumb.fail });
    }
  }

  // ---- Step 2: embed ----
  const embedConfig = {
    baseUrl: process.env.EMBEDDING_URL || 'http://127.0.0.1:12333', model,
    timeout: parseInt(process.env.EMBEDDING_TIMEOUT || '120000', 10),
    dims: parseInt(process.env.EMBEDDING_DIMS || '768', 10)
  };
  const hasEmb = await inList(`SELECT file_id FROM file_embeddings WHERE model = ? AND file_id IN (__IDS__)`, [model]);
  const needEmbed = files.filter(f => !hasEmb.has(f.id));
  summary.embed.need = needEmbed.length;
  log('Step 2 embed: need', { need: needEmbed.length });
  const client = new EmbeddingClient(embedConfig);
  let embedOk = true;
  if (!DRY && needEmbed.length) {
    const es = await ensureEmbeddingServer({ timeoutMs: 120000, log: (m) => log(m) });
    summary.embedServer = es;
    if (!es.ok) { embedOk = false; log('Embedding server not available — skipping embed', { url: embedConfig.baseUrl, error: es.error }); }
  }
  if (!DRY && embedOk && needEmbed.length) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfs-daily-'));
    let i = 0;
    for (const f of needEmbed) {
      i++;
      const t = await db.getThumbnailForScannedFile(f);
      if (!t) { summary.embed.noThumb++; continue; }
      const tmp = path.join(tmpDir, `${f.id}.jpg`);
      try {
        fs.writeFileSync(tmp, t.thumb_data);
        const emb = await client.embedImage(tmp);
        await db.upsertFileEmbedding(f.id, { embedding: emb.embedding, model: emb.model || model, dims: emb.dims, sourceMtime: f.mtime || null });
        summary.embed.ok++;
      } catch (e) { summary.embed.fail++; fail('embed', f, e); }
      finally { try { fs.unlinkSync(tmp); } catch {} }
      if (i % 200 === 0) log('embed progress', { done: i, total: needEmbed.length, ok: summary.embed.ok, fail: summary.embed.fail });
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  // ---- Step 3: classify ----
  const hasCat = await inList(`SELECT file_id FROM file_embedding_categories WHERE model = ? AND file_id IN (__IDS__)`, [model]);
  const hasEmb2 = DRY ? hasEmb : await inList(`SELECT file_id FROM file_embeddings WHERE model = ? AND file_id IN (__IDS__)`, [model]);
  const needCls = files.filter(f => hasEmb2.has(f.id) && !hasCat.has(f.id));
  summary.classify.need = needCls.length;
  log('Step 3 classify: need (has embedding, no category)', { need: needCls.length });
  if (!DRY && needCls.length) {
    const classifier = new EmbedClassifier({ embedConfig,
      minScore: parseFloat(process.env.EMBED_CLASSIFY_MIN_SCORE || '0.25'),
      dualMinScore: parseFloat(process.env.EMBED_CLASSIFY_DUAL_MIN_SCORE || '0.5') });
    const prototypes = await classifier.ensurePrototypes(db, { forceRefresh: false });
    for (let i = 0; i < needCls.length; i += 500) {
      const chunk = needCls.slice(i, i + 500);
      const [embRows] = await conn.query(`SELECT file_id, embedding, dims FROM file_embeddings WHERE model = ? AND file_id IN (${chunk.map(() => '?').join(',')})`, [model, ...chunk.map(f => f.id)]);
      for (const r of embRows) {
        try {
          const v = classifier.classify(bufToFloats(r.embedding, r.dims), prototypes);
          await db.upsertFileEmbeddingCategory(r.file_id, { model, category: v.category, score: v.score, category2: v.category2, score2: v.score2, tags: v.tags });
          summary.classify.ok++;
        } catch (e) { summary.classify.fail++; fail('classify', { id: r.file_id }, e); }
      }
    }
  }
} catch (e) {
  if (!e.benign) { summary.error = String(e?.message || e); log('ERROR', { error: summary.error }); }
} finally {
  summary.elapsedSec = Math.round((Date.now() - t0) / 1000);
  log('SUMMARY', summary);
  if (stopEmbeddingServer()) log('Stopped llama-server started by this run');
  try { await db?.close(); } catch {}
}
process.exit(summary.error ? 1 : 0);

