/**
 * Durable daily-pipeline job: rescan -> exif -> thumb -> embed -> classify (-> missing-report).
 * Same selection rules as scripts/daily-ai-pipeline.js (camera/screenshot, online drives only).
 * Read-only on user files; never marks deleted. Progress via updateJob for /jobs UI.
 *
 * params:
 *   limit (default 10000), offset (default 0), batchSize (optional slice after offset)
 *   stages: string|string[] — rescan,exif,thumb,embed,classify,missing-report,all
 *   noRescan, allImages, dryRun
 *   pathPrefix (e.g. "H:\\"), skipRecycle (default true)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import heicConvert from 'heic-convert';
import { EmbeddingClient, ensureEmbeddingServer, stopEmbeddingServer } from './embedding-client.js';
import { EmbedClassifier } from './embed-classifier.js';
import { partitionByDriveOnline, isDriveRootAccessibleAsync } from './drive-online.js';
import { ensureDateSourceColumn, extractPhotoMetaForFiles } from './photo-meta-extract.js';
import { rescanFolderRecursive } from './folder-rescan.js';
import { buildExtractPathFilters, normalizePathPrefix } from './extract-photo-meta-job.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THUMB_MAX = 400;
const IMG_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'avif'];
const ALL_STAGES = ['rescan', 'exif', 'thumb', 'embed', 'classify', 'missing-report'];

function parseStages(raw) {
  if (raw == null || raw === '' || raw === 'all') return [...ALL_STAGES];
  const list = Array.isArray(raw) ? raw : String(raw).split(/[,+\s]+/);
  const out = [];
  for (const s of list) {
    const t = String(s || '').trim().toLowerCase();
    if (!t) continue;
    if (t === 'all') return [...ALL_STAGES];
    if (t === 'thumbs' || t === 'thumbnail' || t === 'thumbnails') out.push('thumb');
    else if (t === 'missing' || t === 'missing-report' || t === 'missing_report') out.push('missing-report');
    else if (ALL_STAGES.includes(t)) out.push(t);
  }
  return out.length ? [...new Set(out)] : [...ALL_STAGES];
}

function buildImageFilterSql(conn, { allImages = false } = {}) {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'daily-pipeline-filter.json'), 'utf8').replace(/^\uFEFF/, ''));
  } catch { cfg = {}; }
  const q = (v) => conn.escape(v);
  const like = (col, kw) => `${col} LIKE ${q('%' + kw + '%')}`;
  const fullPath = "CONCAT(COALESCE(ft.folder_id,''), CHAR(92), sf.name)";
  const shot = (cfg.screenshotKeywords || []).map((k) => like(fullPath, k));
  const cam = (cfg.cameraPathKeywords || []).map((k) => like('ft.folder_id', k));
  if (cfg.cameraNameRegex) cam.push(`sf.name REGEXP ${q(cfg.cameraNameRegex)}`);
  if (cfg.useExifCamera !== false) {
    cam.push("EXISTS (SELECT 1 FROM photo_metadata pm WHERE pm.file_id = sf.id AND COALESCE(pm.camera_model, pm.camera_make, '') <> '')");
  }
  const shotSql = shot.length ? '(' + shot.join(' OR ') + ')' : '0';
  const camSql = cam.length ? '(' + cam.join(' OR ') + ')' : '0';
  const days = Number.isFinite(+cfg.maxFutureDays) ? +cfg.maxFutureDays : 1;
  return {
    kindSql: `CASE WHEN ${shotSql} THEN 'screenshot' WHEN ${camSql} THEN 'camera' ELSE 'other' END`,
    whereSql: (allImages ? '' : `AND (${shotSql} OR ${camSql})`) + ` AND sf.mtime <= NOW() + INTERVAL ${days} DAY`
  };
}

function computeQuickHash(filePath) {
  try {
    const size = fs.statSync(filePath).size;
    const fd = fs.openSync(filePath, 'r');
    const n = Math.min(65536, size);
    const head = Buffer.alloc(n);
    const tail = Buffer.alloc(n);
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

function folderUnderPrefix(folder, prefix) {
  if (!prefix) return true;
  const f = String(folder || '').replace(/\//g, '\\').replace(/\\+$/, '');
  const fl = f.toLowerCase();
  const pl = String(prefix).toLowerCase();
  return fl === pl || fl.startsWith(pl + '\\');
}

function throwIfCancelled(isCancelled, jobId) {
  if (isCancelled?.(jobId)) {
    const err = new Error('Cancelled');
    err.cancelled = true;
    throw err;
  }
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
export async function runDailyPipelineJob({ db, jobId, params = {}, updateJob, isCancelled, completeJob }) {
  const conn = db.connection;
  const LIMIT = Math.max(1, parseInt(params.limit, 10) || 10000);
  const OFFSET = Math.max(0, parseInt(params.offset, 10) || 0);
  const BATCH = params.batchSize != null && params.batchSize !== ''
    ? Math.max(1, parseInt(params.batchSize, 10) || 1000)
    : null;
  const stages = parseStages(params.stages ?? params.stage);
  const NO_RESCAN = !!params.noRescan || !stages.includes('rescan');
  const ALL_IMAGES = !!params.allImages;
  const DRY = !!params.dryRun;
  const pathFilter = buildExtractPathFilters({
    pathPrefix: params.pathPrefix || params.path_prefix || null,
    skipRecycle: params.skipRecycle !== false && params.skip_recycle !== false,
    skipFolders: params.skipFolders || params.skip_folders
  });
  const PATH_PREFIX = pathFilter.pathPrefix;
  const model = process.env.EMBEDDING_MODEL || 'embeddinggemma-2';
  const embedConfig = {
    baseUrl: process.env.EMBEDDING_URL || 'http://127.0.0.1:12333',
    model,
    timeout: parseInt(process.env.EMBEDDING_TIMEOUT || '120000', 10),
    dims: parseInt(process.env.EMBEDDING_DIMS || '768', 10)
  };

  const summary = {
    limit: LIMIT, offset: OFFSET, batchSize: BATCH, stages, dryRun: DRY,
    pathPrefix: PATH_PREFIX, skipRecycle: pathFilter.skipRecycle,
    rescan: [], selected: 0, skippedOffline: 0,
    thumb: { need: 0, ok: 0, fail: 0, missingFile: 0 },
    exif: { need: 0 },
    embed: { need: 0, ok: 0, fail: 0, noThumb: 0 },
    classify: { need: 0, ok: 0, fail: 0 },
    missingReport: null,
    failSamples: []
  };
  const fail = (stage, f, err) => {
    if (summary.failSamples.length < 20) {
      summary.failSamples.push({ stage, id: f?.id, name: f?.name, error: String(err?.message || err).slice(0, 200) });
    }
  };
  const t0 = Date.now();
  let startedEmbedServer = false;

  updateJob(jobId, {
    total: 0,
    done: 0,
    message: `Daily pipeline: ${stages.join('→')}`,
    meta: { kind: 'daily-pipeline', stages, limit: LIMIT, offset: OFFSET, batchSize: BATCH, pathPrefix: PATH_PREFIX, skipRecycle: pathFilter.skipRecycle }
  });

  try {
    // ---- rescan ----
    if (stages.includes('rescan') && !NO_RESCAN) {
      throwIfCancelled(isCancelled, jobId);
      updateJob(jobId, { message: 'Rescanning configured folders…' });
      let folders = [];
      try {
        folders = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'daily-refresh-folders.json'), 'utf8')).folders || [];
      } catch (e) {
        summary.rescan.push({ error: e.message });
      }
      if (PATH_PREFIX) {
        const before = folders.length;
        folders = folders.filter((f) => folderUnderPrefix(f, PATH_PREFIX));
        summary.rescanFilter = { pathPrefix: PATH_PREFIX, before, after: folders.length };
      }
      for (const folder of folders) {
        throwIfCancelled(isCancelled, jobId);
        const t = Date.now();
        if (!(await isDriveRootAccessibleAsync(folder, 3000))) {
          summary.rescan.push({ folder, skipped: 'drive offline' });
          continue;
        }
        if (!fs.existsSync(folder)) {
          summary.rescan.push({ folder, skipped: 'not found' });
          continue;
        }
        if (DRY) {
          summary.rescan.push({ folder, skipped: 'dry-run' });
          continue;
        }
        try {
          const r = await rescanFolderRecursive(db, folder, { removeMissing: false });
          r.sec = Math.round((Date.now() - t) / 1000);
          summary.rescan.push({ folder, ...r });
          updateJob(jobId, { message: `Rescan done: ${folder}`, meta: { lastRescan: { folder, ...r } } });
        } catch (e) {
          summary.rescan.push({ folder, error: e.message });
        }
      }
    }

    // ---- select files ----
    throwIfCancelled(isCancelled, jobId);
    updateJob(jobId, { message: `Selecting latest camera/screenshot images${PATH_PREFIX ? ' under ' + PATH_PREFIX + '\\' : ''}…` });
    const flt = buildImageFilterSql(conn, { allImages: ALL_IMAGES });
    const fetchN = (LIMIT + OFFSET) * 2;
    // Escape path filter (avoid ? colliding with REGEXP ? in cameraNameRegex)
    const pathSqlEsc = (() => { let i = 0; const a = pathFilter.args; return pathFilter.sql.replace(/\?/g, () => conn.escape(a[i++])); })();
    const selectSql = `
      SELECT sf.id, sf.name, sf.size, sf.hash, sf.md5, sf.quick_hash, sf.mtime, sf.ctime, ${flt.kindSql} AS kind,
             CONCAT(TRIM(TRAILING CHAR(92) FROM COALESCE(ft.folder_id,'')), CHAR(92), sf.name) AS path
      FROM scanned_files sf
      JOIN folder_tree ft ON ft.id = sf.folder_id_int
      WHERE LOWER(COALESCE(sf.extension,'')) IN (${IMG_EXTS.map((e) => `'${e}'`).join(',')})
        ${flt.whereSql}
        ${pathSqlEsc}
      ORDER BY sf.mtime DESC, sf.id DESC
      LIMIT ${fetchN}`;
    const [rows] = await conn.query(selectSql);
    const { online, skippedOffline } = await partitionByDriveOnline(rows, {});
    let files = online.slice(OFFSET, OFFSET + LIMIT);
    if (BATCH != null) files = files.slice(0, BATCH);
    summary.selected = files.length;
    summary.skippedOffline = skippedOffline.length;
    summary.kinds = files.reduce((a, f) => ((a[f.kind] = (a[f.kind] || 0) + 1), a), {});
    summary.newest = files[0]?.mtime;
    summary.oldest = files[files.length - 1]?.mtime;
    summary.samplePaths = files.filter((_, i) => i % Math.max(1, Math.floor(files.length / 5) || 1) === 0).slice(0, 5).map((f) => f.path);

    if (!files.length) {
      completeJob(jobId, summary, 'No files selected');
      return summary;
    }

    const ids = files.map((f) => f.id);
    const inList = async (sql, paramsArr = []) => {
      const out = new Set();
      for (let i = 0; i < ids.length; i += 1000) {
        const chunk = ids.slice(i, i + 1000);
        const [r] = await conn.query(sql.replace('__IDS__', chunk.map(() => '?').join(',')), [...paramsArr, ...chunk]);
        r.forEach((x) => out.add(x.file_id));
      }
      return out;
    };

    // ---- exif ----
    if (stages.includes('exif')) {
      throwIfCancelled(isCancelled, jobId);
      const hasMeta = await inList('SELECT DISTINCT file_id FROM photo_metadata WHERE file_id IN (__IDS__)');
      const needMeta = files.filter((f) => !hasMeta.has(f.id));
      summary.exif = { need: needMeta.length };
      updateJob(jobId, {
        total: needMeta.length || 1,
        done: 0,
        message: `EXIF: need ${needMeta.length}`,
        meta: { stage: 'exif', selected: files.length }
      });
      if (!DRY && needMeta.length) {
        await ensureDateSourceColumn(conn);
        Object.assign(summary.exif, await extractPhotoMetaForFiles(db, needMeta, {
          concurrency: 8,
          onFail: (st, f, e) => fail('exif-' + st, f, e)
        }));
        updateJob(jobId, {
          done: needMeta.length,
          total: needMeta.length,
          message: 'EXIF done ' + JSON.stringify({
            need: summary.exif.need,
            exif: summary.exif.exif,
            created: summary.exif.created,
            fail: summary.exif.fail
          })
        });
      }
    }

    // ---- thumb ----
    if (stages.includes('thumb')) {
      throwIfCancelled(isCancelled, jobId);
      const needThumb = [];
      for (const f of files) {
        const t = await db.getThumbnailForScannedFile(f);
        if (!t) needThumb.push(f);
      }
      summary.thumb.need = needThumb.length;
      updateJob(jobId, {
        total: needThumb.length || 1,
        done: 0,
        message: `Thumbs: need ${needThumb.length} / selected ${files.length}`,
        meta: { stage: 'thumb', need: needThumb.length, selected: files.length }
      });
      if (!DRY) {
        let i = 0;
        for (const f of needThumb) {
          throwIfCancelled(isCancelled, jobId);
          i++;
          try {
            if (!fs.existsSync(f.path)) { summary.thumb.missingFile++; }
            else {
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
            }
          } catch (e) { summary.thumb.fail++; fail('thumb', f, e); }
          if (i % 25 === 0 || i === needThumb.length) {
            updateJob(jobId, {
              done: i,
              total: needThumb.length,
              currentItem: f.name,
              message: `Thumb ${i}/${needThumb.length} ok=${summary.thumb.ok} fail=${summary.thumb.fail}`
            });
          }
        }
      }
    }

    // ---- embed ----
    if (stages.includes('embed')) {
      throwIfCancelled(isCancelled, jobId);
      const hasEmb = await inList('SELECT file_id FROM file_embeddings WHERE model = ? AND file_id IN (__IDS__)', [model]);
      const needEmbed = files.filter((f) => !hasEmb.has(f.id));
      summary.embed.need = needEmbed.length;
      updateJob(jobId, {
        total: needEmbed.length || 1,
        done: 0,
        message: `Embed: need ${needEmbed.length}`,
        meta: { stage: 'embed', need: needEmbed.length }
      });
      if (!DRY && needEmbed.length) {
        const es = await ensureEmbeddingServer({ timeoutMs: 120000, log: () => {} });
        summary.embedServer = es;
        if (es.started) startedEmbedServer = true;
        if (!es.ok) {
          summary.embed.fail = needEmbed.length;
          fail('embed', { id: 0, name: 'server' }, new Error(es.error || 'Embedding server unavailable'));
        } else {
          const client = new EmbeddingClient(embedConfig);
          const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfs-daily-job-'));
          let i = 0;
          try {
            for (const f of needEmbed) {
              throwIfCancelled(isCancelled, jobId);
              i++;
              const t = await db.getThumbnailForScannedFile(f);
              if (!t) { summary.embed.noThumb++; }
              else {
                const tmp = path.join(tmpDir, `${f.id}.jpg`);
                try {
                  fs.writeFileSync(tmp, t.thumb_data);
                  const emb = await client.embedImage(tmp);
                  await db.upsertFileEmbedding(f.id, {
                    embedding: emb.embedding,
                    model: emb.model || model,
                    dims: emb.dims,
                    sourceMtime: f.mtime || null
                  });
                  summary.embed.ok++;
                } catch (e) { summary.embed.fail++; fail('embed', f, e); }
                finally { try { fs.unlinkSync(tmp); } catch {} }
              }
              if (i % 20 === 0 || i === needEmbed.length) {
                updateJob(jobId, {
                  done: i,
                  total: needEmbed.length,
                  currentItem: f.name,
                  message: `Embed ${i}/${needEmbed.length} ok=${summary.embed.ok} fail=${summary.embed.fail} noThumb=${summary.embed.noThumb}`
                });
              }
            }
          } finally {
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
          }
        }
      }
    }

    // ---- classify ----
    if (stages.includes('classify')) {
      throwIfCancelled(isCancelled, jobId);
      const hasCat = await inList('SELECT file_id FROM file_embedding_categories WHERE model = ? AND file_id IN (__IDS__)', [model]);
      const hasEmb2 = await inList('SELECT file_id FROM file_embeddings WHERE model = ? AND file_id IN (__IDS__)', [model]);
      const needCls = files.filter((f) => hasEmb2.has(f.id) && !hasCat.has(f.id));
      summary.classify.need = needCls.length;
      updateJob(jobId, {
        total: needCls.length || 1,
        done: 0,
        message: `Classify: need ${needCls.length}`,
        meta: { stage: 'classify', need: needCls.length }
      });
      if (!DRY && needCls.length) {
        const classifier = new EmbedClassifier({
          embedConfig,
          minScore: parseFloat(process.env.EMBED_CLASSIFY_MIN_SCORE || '0.25'),
          dualMinScore: parseFloat(process.env.EMBED_CLASSIFY_DUAL_MIN_SCORE || '0.5')
        });
        const prototypes = await classifier.ensurePrototypes(db, { forceRefresh: false });
        let done = 0;
        for (let i = 0; i < needCls.length; i += 500) {
          throwIfCancelled(isCancelled, jobId);
          const chunk = needCls.slice(i, i + 500);
          const [embRows] = await conn.query(
            `SELECT file_id, embedding, dims FROM file_embeddings WHERE model = ? AND file_id IN (${chunk.map(() => '?').join(',')})`,
            [model, ...chunk.map((f) => f.id)]
          );
          for (const r of embRows) {
            try {
              const v = classifier.classify(bufToFloats(r.embedding, r.dims), prototypes);
              await db.upsertFileEmbeddingCategory(r.file_id, {
                model,
                category: v.category,
                score: v.score,
                category2: v.category2,
                score2: v.score2,
                tags: v.tags
              });
              summary.classify.ok++;
            } catch (e) { summary.classify.fail++; fail('classify', { id: r.file_id }, e); }
            done++;
            if (done % 100 === 0 || done === needCls.length) {
              updateJob(jobId, {
                done,
                total: needCls.length,
                message: `Classify ${done}/${needCls.length} ok=${summary.classify.ok}`
              });
            }
          }
        }
      }
    }

    // ---- missing report ----
    if (stages.includes('missing-report')) {
      throwIfCancelled(isCancelled, jobId);
      updateJob(jobId, { message: 'Writing daily missing-files report…' });
      try {
        const r = spawnSync(process.execPath, ['scripts/daily-missing-report.js', '--sample', '200'], {
          cwd: ROOT, encoding: 'utf8', env: process.env, timeout: 30 * 60 * 1000
        });
        const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        summary.missingReport = {
          exitCode: r.status,
          log: `logs/daily-missing-${day}.log`,
          json: `logs/daily-missing-${day}.json`,
          stderr: (r.stderr || '').slice(0, 500) || undefined
        };
      } catch (e) {
        summary.missingReport = { error: String(e?.message || e) };
      }
    }

    summary.elapsedSec = Math.round((Date.now() - t0) / 1000);
    const msg = [
      `selected=${summary.selected}`,
      stages.includes('thumb') ? `thumb ok=${summary.thumb.ok}/${summary.thumb.need}` : null,
      stages.includes('embed') ? `embed ok=${summary.embed.ok}/${summary.embed.need}` : null,
      stages.includes('classify') ? `cls ok=${summary.classify.ok}/${summary.classify.need}` : null,
      `${summary.elapsedSec}s`
    ].filter(Boolean).join(' · ');
    completeJob(jobId, summary, msg);
    return summary;
  } catch (e) {
    if (e?.cancelled) {
      summary.elapsedSec = Math.round((Date.now() - t0) / 1000);
      summary.cancelled = true;
      throw e;
    }
    summary.error = String(e?.message || e);
    summary.elapsedSec = Math.round((Date.now() - t0) / 1000);
    throw e;
  } finally {
    if (startedEmbedServer) {
      try { stopEmbeddingServer(); } catch {}
    }
  }
}

export default { runDailyPipelineJob };
