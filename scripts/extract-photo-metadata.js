#!/usr/bin/env node
/**
 * Backfill photo_metadata for images missing it, newest mtime first. Resumable (keyset cursor in status file).
 * Read-only on user files; offline drive roots skipped (never marked deleted).
 * Always skips $RECYCLE.BIN / #recycle. Optional --path-prefix H:\ to limit scope.
 * Usage: node scripts/extract-photo-metadata.js [--limit N] [--batch 500] [--concurrency 8] [--reset] [--path-prefix H:\] [--no-skip-recycle]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { DatabaseManager } from '../lib/database.js';
import { loadConfig } from '../lib/utils.js';
import { partitionByDriveOnline } from '../lib/drive-online.js';
import { MediaMetadataExtractor, PHOTO_EXTS, ensureDateSourceColumn, extractPhotoMetaForFiles } from '../lib/photo-meta-extract.js';
import { buildExtractPathFilters } from '../lib/extract-photo-meta-job.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT); dotenv.config({ quiet: true });
const argv = process.argv.slice(2);
const val = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const LIMIT = parseInt(val('--limit', '0'), 10) || 0;
const BATCH = parseInt(val('--batch', '500'), 10);
const CONC = parseInt(val('--concurrency', '8'), 10);
const pathPrefix = val('--path-prefix', '') || null;
const skipRecycle = !argv.includes('--no-skip-recycle');
const pathFilter = buildExtractPathFilters({ pathPrefix, skipRecycle });
fs.mkdirSync('logs', { recursive: true }); fs.mkdirSync('tmp', { recursive: true });
const LOG = path.join('logs', `extract-photo-metadata-${new Date().toISOString().slice(0,10).replace(/-/g,'')}.log`);
const STATUS = path.join('tmp', 'extract-photo-metadata-status.json');
const log = (m, o) => fs.appendFileSync(LOG, `${new Date().toISOString()} ${m}${o ? ' ' + JSON.stringify(o) : ''}\n`);
let status = {};
try { if (!argv.includes('--reset')) status = JSON.parse(fs.readFileSync(STATUS, 'utf8')); } catch {}
const tot = status.totals || { processed: 0, exif: 0, created: 0, mtime: 0, missingFile: 0, fail: 0, already: 0, offline: 0 };
const save = (extra = {}) => fs.writeFileSync(STATUS, JSON.stringify({ ...status, ...extra, totals: tot, pid: process.pid, updatedAt: new Date().toISOString() }, null, 2));

const db = new DatabaseManager(loadConfig().database);
await db.connect();
const conn = db.connection;
await ensureDateSourceColumn(conn);
const extractor = new MediaMetadataExtractor();
const started = Date.now(); let done = 0;
status.startedAt = status.startedAt || new Date().toISOString();
const [[{ n: remaining0 }]] = await conn.query(
  `SELECT COUNT(*) n FROM scanned_files sf
   JOIN folder_tree ft ON ft.id = sf.folder_id_int
   WHERE LOWER(COALESCE(sf.extension,'')) IN (?)
     ${pathFilter.sql}
     AND NOT EXISTS (SELECT 1 FROM photo_metadata pm WHERE pm.file_id=sf.id)`,
  [PHOTO_EXTS, ...pathFilter.args]
);
log('start', { remaining: remaining0, cursor: status.cursor, pid: process.pid, pathPrefix: pathFilter.pathPrefix, skipRecycle: pathFilter.skipRecycle });
save({ state: 'running', remainingAtStart: remaining0, pathPrefix: pathFilter.pathPrefix, skipRecycle: pathFilter.skipRecycle });
try {
  while (!LIMIT || done < LIMIT) {
    const c = status.cursor;
    const [rows] = await conn.query(`
      SELECT sf.id, sf.mtime, sf.ctime, CONCAT(TRIM(TRAILING CHAR(92) FROM COALESCE(ft.folder_id,'')), CHAR(92), sf.name) AS path
      FROM scanned_files sf JOIN folder_tree ft ON ft.id = sf.folder_id_int
      WHERE LOWER(COALESCE(sf.extension,'')) IN (?)
        ${pathFilter.sql}
        ${c ? 'AND (sf.mtime < ? OR (sf.mtime = ? AND sf.id < ?))' : ''}
        AND NOT EXISTS (SELECT 1 FROM photo_metadata pm WHERE pm.file_id = sf.id)
      ORDER BY sf.mtime DESC, sf.id DESC LIMIT ?`,
      c
        ? [PHOTO_EXTS, ...pathFilter.args, c.mtime, c.mtime, c.id, BATCH]
        : [PHOTO_EXTS, ...pathFilter.args, BATCH]);
    if (!rows.length) break;
    const { online, skippedOffline } = await partitionByDriveOnline(rows, { log: () => {} });
    tot.offline += skippedOffline.length;
    const st = await extractPhotoMetaForFiles(db, online, { concurrency: CONC, extractor, onFail: (s, f, e) => log('fail', { s, id: f.id, path: f.path, e: String(e?.message || e).slice(0, 200) }) });
    for (const k of Object.keys(st)) tot[k] = (tot[k] || 0) + st[k];
    done += rows.length;
    const last = rows[rows.length - 1];
    status.cursor = { mtime: last.mtime, id: last.id };
    const rate = done / ((Date.now() - started) / 1000);
    const etaH = (remaining0 - done) / rate / 3600;
    save({ state: 'running', rate: +rate.toFixed(2), etaHours: +etaH.toFixed(1), doneThisRun: done });
    log('batch', { done, rate: rate.toFixed(2), etaH: etaH.toFixed(1), cursorMtime: last.mtime, sample: rows[0]?.path, ...st });
  }
  save({ state: 'done', finishedAt: new Date().toISOString() }); log('done', tot);
} catch (e) { log('error', { e: e.stack }); save({ state: 'error', error: e.message }); process.exitCode = 1; }
finally { await extractor.cleanup(); await db.close(); }
