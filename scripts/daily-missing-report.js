import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { DatabaseManager } from '../lib/database.js';
import { loadConfig } from '../lib/utils.js';
import { partitionByDriveOnline, isDriveRootAccessibleAsync } from '../lib/drive-online.js';
import { PHOTO_EXTS } from '../lib/photo-meta-extract.js';

/**
 * Daily missing-files report: online-drive existence checks + photo_metadata gap.
 * Never marks files deleted when drive is offline. Read-only on disk.
 * Usage: node scripts/daily-missing-report.js [--sample 200] [--json-only]
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
dotenv.config({ quiet: true });

const argv = process.argv.slice(2);
const val = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SAMPLE = Math.max(50, Math.min(2000, parseInt(val('--sample', '200'), 10) || 200));
const JSON_ONLY = argv.includes('--json-only');

fs.mkdirSync('logs', { recursive: true });
const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const logPath = path.join('logs', `daily-missing-${day}.log`);
const jsonPath = path.join('logs', `daily-missing-${day}.json`);

const lines = [];
const log = (m, o) => {
  const line = `${new Date().toISOString()} ${m}${o ? ' ' + JSON.stringify(o) : ''}`;
  lines.push(line);
  if (!JSON_ONLY) console.log(line);
};

const db = new DatabaseManager(loadConfig().database);
await db.connect();
const conn = db.connection;

const report = {
  generatedAt: new Date().toISOString(),
  timezone: 'Asia/Hong_Kong',
  samplePerRoot: SAMPLE,
  photoMeta: {},
  drives: [],
  missingByDrive: {},
  missingByTopFolder: {},
  samples: [],
  notes: [
    'Files on offline drives are skipped (not counted missing, never marked deleted).',
    'Existence check is read-only (fs.access).'
  ]
};

try {
  const [[{ n: totalImg }]] = await conn.query(
    `SELECT COUNT(*) n FROM scanned_files sf WHERE LOWER(COALESCE(sf.extension,'')) IN (?)`,
    [PHOTO_EXTS]
  );
  const [[{ n: haveMeta }]] = await conn.query(`SELECT COUNT(*) n FROM photo_metadata`);
  const [[{ n: missingMeta }]] = await conn.query(
    `SELECT COUNT(*) n FROM scanned_files sf
     WHERE LOWER(COALESCE(sf.extension,'')) IN (?)
       AND NOT EXISTS (SELECT 1 FROM photo_metadata pm WHERE pm.file_id = sf.id)`,
    [PHOTO_EXTS]
  );
  report.photoMeta = { totalImages: totalImg, haveMeta, missingMeta };
  log('photo_meta', report.photoMeta);

  // Distinct drive roots from folder_tree paths of image files
  const [roots] = await conn.query(`
    SELECT DISTINCT LEFT(TRIM(TRAILING CHAR(92) FROM ft.folder_id), 2) AS drive
    FROM scanned_files sf
    JOIN folder_tree ft ON ft.id = sf.folder_id_int
    WHERE LOWER(COALESCE(sf.extension,'')) IN (?)
      AND ft.folder_id REGEXP '^[A-Za-z]:'
  `, [PHOTO_EXTS]);

  for (const { drive } of roots) {
    const root = drive.endsWith(':') ? drive + '\\' : drive;
    const online = await isDriveRootAccessibleAsync(root, 3000);
    report.drives.push({ drive, root, online });
    log('drive', { drive, online });
    if (!online) continue;

    const [rows] = await conn.query(`
      SELECT sf.id, sf.name, sf.size, sf.mtime,
             CONCAT(TRIM(TRAILING CHAR(92) FROM COALESCE(ft.folder_id,'')), CHAR(92), sf.name) AS path
      FROM scanned_files sf
      JOIN folder_tree ft ON ft.id = sf.folder_id_int
      WHERE LOWER(COALESCE(sf.extension,'')) IN (?)
        AND ft.folder_id LIKE ?
      ORDER BY sf.mtime DESC, sf.id DESC
      LIMIT ?
    `, [PHOTO_EXTS, drive + '%', SAMPLE]);

    let missing = 0, ok = 0;
    for (const row of rows) {
      try {
        await fs.promises.access(row.path);
        ok++;
      } catch {
        missing++;
        const top = row.path.split(/[\\/]/).slice(0, 3).join('\\');
        report.missingByDrive[drive] = (report.missingByDrive[drive] || 0) + 1;
        report.missingByTopFolder[top] = (report.missingByTopFolder[top] || 0) + 1;
        if (report.samples.length < 40) {
          report.samples.push({ id: row.id, path: row.path, size: row.size, mtime: row.mtime });
        }
      }
    }
    log('sample_check', { drive, sampled: rows.length, ok, missing });
  }

  // Pull last EXIF job missingFile if status file exists
  try {
    const st = JSON.parse(fs.readFileSync(path.join('tmp', 'extract-photo-metadata-status.json'), 'utf8'));
    report.lastExifExtract = {
      state: st.state,
      finishedAt: st.finishedAt,
      totals: st.totals,
      updatedAt: st.updatedAt
    };
  } catch { /* none */ }

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(logPath, lines.join('\n') + '\n\nSUMMARY\n' + JSON.stringify({
    photoMeta: report.photoMeta,
    drives: report.drives,
    missingByDrive: report.missingByDrive,
    missingByTopFolder: report.missingByTopFolder,
    sampleCount: report.samples.length
  }, null, 2) + '\n');
  log('wrote', { logPath, jsonPath });
  console.log(JSON.stringify({ ok: true, logPath, jsonPath, photoMeta: report.photoMeta, missingByDrive: report.missingByDrive }, null, 2));
} catch (e) {
  log('error', { e: e.stack || e.message });
  process.exitCode = 1;
} finally {
  await db.close();
}
