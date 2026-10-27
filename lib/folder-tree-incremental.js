/**
 * Incremental folder_tree refresh.
 * Only recomputes direct stats for folders whose scanned_files rows changed
 * (scanned_files.updated_at / deleted_files_archive.deleted_at since last run,
 * or folders under explicit --path prefixes), then recomputes recursive stats
 * for those folders + all ancestors, bottom-up via parent_id.
 * Never touches files on disk.
 */
const META_KEY = 'folder_tree_last_rebuild';
const CHUNK = 1000;

async function ensureMeta(conn) {
  await conn.query(`CREATE TABLE IF NOT EXISTS app_meta (
    k VARCHAR(128) NOT NULL PRIMARY KEY,
    v VARCHAR(1024) NULL,
    updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
}

export async function getLastRebuild(conn) {
  await ensureMeta(conn);
  const [r] = await conn.query('SELECT v FROM app_meta WHERE k = ?', [META_KEY]);
  return r.length ? r[0].v : null;
}

export async function setLastRebuild(conn, ts) {
  await ensureMeta(conn);
  await conn.query('INSERT INTO app_meta (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [META_KEY, ts]);
}

/** DB server time, so comparisons against updated_at use the same clock/zone. */
export async function dbNow(conn) {
  const [r] = await conn.query("SELECT DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s') AS n");
  return r[0].n;
}

function dirOf(p) {
  const s = String(p || '').replace(/\//g, '\\');
  const i = s.lastIndexOf('\\');
  return i > 0 ? s.slice(0, i) : null;
}

async function collectChanged(conn, { since, paths }) {
  const ids = new Set();
  if (since) {
    const [a] = await conn.query(
      'SELECT DISTINCT folder_id_int AS id FROM scanned_files WHERE updated_at >= ? AND folder_id_int IS NOT NULL', [since]);
    a.forEach(r => ids.add(r.id));
    const [d] = await conn.query('SELECT DISTINCT path FROM deleted_files_archive WHERE deleted_at >= ?', [since]);
    const dirs = [...new Set(d.map(r => dirOf(r.path)).filter(Boolean))];
    for (let i = 0; i < dirs.length; i += CHUNK) {
      const b = dirs.slice(i, i + CHUNK);
      const [f] = await conn.query(`SELECT id FROM folder_tree WHERE folder_id IN (${b.map(() => '?').join(',')})`, b);
      f.forEach(r => ids.add(r.id));
    }
  }
  for (const raw of paths || []) {
    const p = String(raw).replace(/\//g, '\\').replace(/\\+$/, '');
    const [f] = await conn.query(
      "SELECT id FROM folder_tree WHERE folder_id = ? OR LEFT(folder_id, CHAR_LENGTH(?) + 1) = CONCAT(?, CHAR(92))",
      [p, p, p]);
    f.forEach(r => ids.add(r.id));
  }
  return ids;
}

async function updateDirect(conn, ids) {
  const arr = [...ids];
  for (let i = 0; i < arr.length; i += CHUNK) {
    const b = arr.slice(i, i + CHUNK);
    const ph = b.map(() => '?').join(',');
    await conn.query(`
      UPDATE folder_tree ft
      LEFT JOIN (
        SELECT folder_id_int AS id, COUNT(*) AS c, COALESCE(SUM(size),0) AS s
        FROM scanned_files WHERE folder_id_int IN (${ph}) GROUP BY folder_id_int
      ) x ON x.id = ft.id
      SET ft.file_count = COALESCE(x.c,0), ft.total_size = COALESCE(x.s,0)
      WHERE ft.id IN (${ph})`, [...b, ...b]);
  }
}

/** Returns Map id -> depth for ids plus all ancestors. */
async function withAncestors(conn, ids) {
  const all = new Map();
  let frontier = [...ids];
  while (frontier.length) {
    const next = [];
    for (let i = 0; i < frontier.length; i += CHUNK) {
      const b = frontier.slice(i, i + CHUNK);
      const [rows] = await conn.query(
        `SELECT id, parent_id, depth FROM folder_tree WHERE id IN (${b.map(() => '?').join(',')})`, b);
      for (const r of rows) {
        if (all.has(r.id)) continue;
        all.set(r.id, r.depth);
        if (r.parent_id && !all.has(r.parent_id)) next.push(r.parent_id);
      }
    }
    frontier = [...new Set(next)];
  }
  return all;
}

async function updateRecursive(conn, depthMap) {
  const byDepth = new Map();
  for (const [id, d] of depthMap) {
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d).push(id);
  }
  const depths = [...byDepth.keys()].sort((a, b) => b - a);
  for (const d of depths) {
    const arr = byDepth.get(d);
    for (let i = 0; i < arr.length; i += CHUNK) {
      const b = arr.slice(i, i + CHUNK);
      const ph = b.map(() => '?').join(',');
      await conn.query(`
        UPDATE folder_tree p
        LEFT JOIN (
          SELECT parent_id, SUM(recursive_count) AS rc, SUM(recursive_size) AS rs
          FROM folder_tree WHERE parent_id IN (${ph}) GROUP BY parent_id
        ) c ON c.parent_id = p.id
        SET p.recursive_count = p.file_count + COALESCE(c.rc,0),
            p.recursive_size  = p.total_size + COALESCE(c.rs,0)
        WHERE p.id IN (${ph})`, [...b, ...b]);
    }
  }
}

/**
 * @param conn mysql2 connection
 * @param opts { paths?: string[], since?: string, all?: boolean (use since from meta) }
 */
export async function incrementalRebuildFolderTree(conn, opts = {}) {
  const t0 = Date.now();
  const startedAt = await dbNow(conn);
  let since = opts.since || null;
  const usingMeta = !opts.paths?.length && !since;
  if (usingMeta) {
    since = await getLastRebuild(conn);
    if (!since) return { needFull: true };
  }
  const changed = await collectChanged(conn, { since, paths: opts.paths });
  await updateDirect(conn, changed);
  const depthMap = await withAncestors(conn, changed);
  await updateRecursive(conn, depthMap);
  // Only advance the watermark for since-based runs (a --path run doesn't cover other folders).
  if (usingMeta || opts.since) await setLastRebuild(conn, startedAt);
  return { since, changed: changed.size, touched: depthMap.size, ms: Date.now() - t0 };
}

