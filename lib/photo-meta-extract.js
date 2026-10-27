/**
 * Photo metadata (EXIF) extraction for scanned_files images missing photo_metadata.
 * Read-only on user files. date_taken falls back to file created (birthtime) -> sf.ctime -> mtime,
 * recorded in photo_metadata.date_source ('exif'|'created'|'mtime').
 */
import fs from 'fs';
import { MediaMetadataExtractor } from './media.js';

export { MediaMetadataExtractor };
export const PHOTO_EXTS = ['jpg','jpeg','png','webp','heic','heif','avif','tif','tiff'];

export async function ensureDateSourceColumn(conn) {
  const [c] = await conn.query("SELECT COUNT(*) n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='photo_metadata' AND COLUMN_NAME='date_source'");
  if (!c[0].n) await conn.query("ALTER TABLE photo_metadata ADD COLUMN date_source VARCHAR(16) NULL");
  const [i] = await conn.query("SELECT COUNT(*) n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='photo_metadata' AND INDEX_NAME='idx_pm_file_id'");
  if (!i[0].n) { try { await conn.query("CREATE INDEX idx_pm_file_id ON photo_metadata(file_id)"); } catch {} }
}

const validDate = (d) => d instanceof Date && !isNaN(d) && d.getFullYear() > 1971 && d.getTime() < Date.now() + 86400000 * 2;

/** files: [{id,path,mtime,ctime}] ; returns stats */
export async function extractPhotoMetaForFiles(db, files, { concurrency = 8, onFail, extractor } = {}) {
  const conn = db.connection;
  const ex = extractor || new MediaMetadataExtractor();
  const st = { processed: 0, exif: 0, created: 0, mtime: 0, missingFile: 0, fail: 0, already: 0 };
  let idx = 0;
  const worker = async () => {
    while (idx < files.length) {
      const f = files[idx++];
      st.processed++;
      try {
        const [e] = await conn.query('SELECT 1 FROM photo_metadata WHERE file_id=? LIMIT 1', [f.id]);
        if (e.length) { st.already++; continue; }
        let stat;
        try { stat = await fs.promises.stat(f.path); } catch { st.missingFile++; continue; } // never mark deleted
        let meta = null;
        try { meta = await ex.extractPhotoMetadata(f.path); } catch (err) { onFail?.('exif', f, err); }
        meta = meta || { format: (f.path.split('.').pop() || '').toLowerCase() };
        const t0 = meta.datetime?.taken; let taken = t0?.toDate ? t0.toDate() : (t0 ? new Date(t0) : null);
        let src = 'exif';
        if (!validDate(taken)) {
          const cands = [['created', stat.birthtime], ['created', f.ctime ? new Date(f.ctime) : null], ['mtime', stat.mtime], ['mtime', f.mtime ? new Date(f.mtime) : null]];
          const hit = cands.find(([, d]) => validDate(d));
          taken = hit ? hit[1] : null; src = hit ? hit[0] : null;
          meta.datetime = { ...(meta.datetime || {}), taken };
        }
        await db.storePhotoMetadata(f.id, meta);
        if (src) await conn.query('UPDATE photo_metadata SET date_source=?, date_taken=COALESCE(date_taken, ?) WHERE file_id=?', [src, taken, f.id]);
        st[src || 'mtime']++;
      } catch (err) { st.fail++; onFail?.('store', f, err); }
    }
  };
  try { await Promise.all(Array.from({ length: concurrency }, worker)); } finally { if (!extractor) await ex.cleanup(); }
  return st;
}


