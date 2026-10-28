/**
 * Durable extract-photo-meta job body (newest-first, batched, resumable cursor).
 * Read-only on user files; offline drives skipped (never mark deleted).
 * Always skips $RECYCLE.BIN / #recycle unless skipRecycle=false.
 * Optional params.pathPrefix (e.g. "H:\\") limits to that drive/folder tree.
 */
import { partitionByDriveOnline } from './drive-online.js';
import { PHOTO_EXTS, ensureDateSourceColumn, extractPhotoMetaForFiles, MediaMetadataExtractor } from './photo-meta-extract.js';

export { PHOTO_EXTS };

/** @param {string|null|undefined} p */
export function normalizePathPrefix(p) {
  if (p == null || p === '') return null;
  let s = String(p).trim().replace(/\//g, '\\');
  while (s.endsWith('\\')) s = s.slice(0, -1);
  return s || null;
}

/**
 * Build SQL AND-clauses + bind args for pathPrefix / recycle skips.
 * Always join folder_tree as `ft`.
 */
export function buildExtractPathFilters(params = {}) {
  const clauses = [];
  const args = [];
  const prefix = normalizePathPrefix(params.pathPrefix);
  if (prefix) {
    clauses.push('(ft.folder_id = ? OR ft.folder_id LIKE CONCAT(?, CHAR(92), \'%\'))');
    args.push(prefix, prefix);
  }
  const skipRecycle = params.skipRecycle !== false; // default ON
  const skipFolders = [];
  if (skipRecycle) {
    skipFolders.push('$RECYCLE.BIN', '#recycle');
  }
  for (const f of (params.skipFolders || [])) {
    const name = String(f || '').trim();
    if (name) skipFolders.push(name);
  }
  const seen = new Set();
  for (const name of skipFolders) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    clauses.push('LOWER(ft.folder_id) NOT LIKE ?');
    args.push('%' + key + '%');
  }
  return {
    pathPrefix: prefix,
    skipRecycle,
    skipFolders: [...seen],
    sql: clauses.length ? (' AND ' + clauses.join(' AND ')) : '',
    args
  };
}

/**
 * @param {object} opts
 * @param {import('./database.js').DatabaseManager} opts.db
 * @param {string} opts.jobId
 * @param {object} opts.params
 * @param {(id:string, patch:object)=>any} opts.updateJob
 * @param {(id:string)=>boolean} opts.isCancelled
 * @param {(id:string, result:any, msg?:string)=>any} opts.completeJob
 */
export async function runExtractPhotoMetaJob({ db, jobId, params = {}, updateJob, isCancelled, completeJob }) {
  const conn = db.connection;
  await ensureDateSourceColumn(conn);

  const BATCH = Math.max(50, Math.min(2000, parseInt(params.batch, 10) || 500));
  const CONC = Math.max(1, Math.min(16, parseInt(params.concurrency, 10) || 8));
  const LIMIT = parseInt(params.limit, 10) || 0; // 0 = all missing
  const reset = !!params.reset;
  const pathFilter = buildExtractPathFilters(params);

  const [[{ n: remaining0 }]] = await conn.query(
    `SELECT COUNT(*) n FROM scanned_files sf
     JOIN folder_tree ft ON ft.id = sf.folder_id_int
     WHERE LOWER(COALESCE(sf.extension,'')) IN (?)
       ${pathFilter.sql}
       AND NOT EXISTS (SELECT 1 FROM photo_metadata pm WHERE pm.file_id = sf.id)`,
    [PHOTO_EXTS, ...pathFilter.args]
  );

  let cursor = (!reset && params.cursor && params.cursor.mtime != null) ? params.cursor : null;
  const totals = {
    processed: 0, exif: 0, created: 0, mtime: 0, missingFile: 0, fail: 0, already: 0, offline: 0, batches: 0
  };
  const target = LIMIT > 0 ? Math.min(LIMIT, remaining0) : remaining0;
  const scopeMsg = pathFilter.pathPrefix ? ` under ${pathFilter.pathPrefix}\\` : '';
  updateJob(jobId, {
    total: target,
    done: 0,
    message: `EXIF extract${scopeMsg}: ${remaining0.toLocaleString()} missing (skip recycle)`,
    meta: {
      remainingAtStart: remaining0,
      batch: BATCH,
      concurrency: CONC,
      limit: LIMIT || null,
      cursor,
      pathPrefix: pathFilter.pathPrefix,
      skipRecycle: pathFilter.skipRecycle,
      skipFolders: pathFilter.skipFolders
    }
  });

  const extractor = new MediaMetadataExtractor();
  const started = Date.now();
  let doneThisRun = 0;
  const samplePaths = [];

  try {
    while (!LIMIT || doneThisRun < LIMIT) {
      if (isCancelled(jobId)) throw new Error('Cancelled');

      const take = LIMIT ? Math.min(BATCH, LIMIT - doneThisRun) : BATCH;
      const c = cursor;
      const [rows] = await conn.query(
        `SELECT sf.id, sf.mtime, sf.ctime,
                CONCAT(TRIM(TRAILING CHAR(92) FROM COALESCE(ft.folder_id,'')), CHAR(92), sf.name) AS path
         FROM scanned_files sf
         JOIN folder_tree ft ON ft.id = sf.folder_id_int
         WHERE LOWER(COALESCE(sf.extension,'')) IN (?)
           ${pathFilter.sql}
           ${c ? 'AND (sf.mtime < ? OR (sf.mtime = ? AND sf.id < ?))' : ''}
           AND NOT EXISTS (SELECT 1 FROM photo_metadata pm WHERE pm.file_id = sf.id)
         ORDER BY sf.mtime DESC, sf.id DESC
         LIMIT ?`,
        c
          ? [PHOTO_EXTS, ...pathFilter.args, c.mtime, c.mtime, c.id, take]
          : [PHOTO_EXTS, ...pathFilter.args, take]
      );

      if (!rows.length) break;

      for (const r of rows) {
        if (samplePaths.length < 8 && r.path) samplePaths.push(r.path);
      }

      const { online, skippedOffline } = await partitionByDriveOnline(rows, { log: () => {} });
      totals.offline += skippedOffline.length;

      const st = await extractPhotoMetaForFiles(db, online, {
        concurrency: CONC,
        extractor,
        onFail: () => {}
      });
      for (const k of Object.keys(st)) totals[k] = (totals[k] || 0) + st[k];

      doneThisRun += rows.length;
      totals.batches++;
      const last = rows[rows.length - 1];
      cursor = { mtime: last.mtime, id: last.id };

      const rate = doneThisRun / Math.max(0.001, (Date.now() - started) / 1000);
      const left = Math.max(0, target - doneThisRun);
      const etaMin = rate > 0 ? left / rate / 60 : null;
      updateJob(jobId, {
        done: Math.min(target, doneThisRun),
        currentItem: online[0]?.path || rows[0]?.path || null,
        message: `EXIF ${doneThisRun}/${target} · ${rate.toFixed(1)}/s` + (etaMin != null ? ` · ETA ${etaMin.toFixed(0)}m` : ''),
        meta: {
          remainingAtStart: remaining0,
          cursor,
          rate: +rate.toFixed(2),
          etaMinutes: etaMin != null ? +etaMin.toFixed(1) : null,
          totals: { ...totals },
          pathPrefix: pathFilter.pathPrefix,
          skipRecycle: pathFilter.skipRecycle,
          samplePaths: samplePaths.slice(0, 8)
        }
      });
    }

    const payload = {
      remainingAtStart: remaining0,
      doneThisRun,
      totals,
      cursor,
      batch: BATCH,
      concurrency: CONC,
      pathPrefix: pathFilter.pathPrefix,
      skipRecycle: pathFilter.skipRecycle,
      skipFolders: pathFilter.skipFolders,
      samplePaths: samplePaths.slice(0, 8)
    };
    completeJob(jobId, payload, `Done: processed=${totals.processed} exif=${totals.exif} created=${totals.created} missingFile=${totals.missingFile} offline=${totals.offline} fail=${totals.fail} pathPrefix=${pathFilter.pathPrefix || 'ALL'}`);
    return payload;
  } finally {
    try { await extractor.cleanup(); } catch { /* ignore */ }
  }
}
