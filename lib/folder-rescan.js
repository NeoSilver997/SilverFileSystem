/**
 * Read-only folder rescan for CLI jobs (same logic as server.js rescanFolderOneLevel).
 * Reads the disk, inserts new files / updates changed size+mtime, discovers child folders.
 * By default NEVER removes DB rows for files missing on disk (removeMissing=false);
 * missing ones are only counted. Offline drive roots are skipped by the caller.
 * Never touches files on disk.
 */
import fs from 'fs';
import path from 'path';

const toSql = (d) => {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  return isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 19).replace('T', ' ');
};

/** Make sure folder_tree has rows for folderPath and all its ancestors. Returns id. */
export async function ensureFolderPath(db, folderPath) {
  const clean = folderPath.replace(/\//g, '\\').replace(/\\+$/, '');
  const parts = clean.split('\\').filter(Boolean);
  let parentId = null;
  let cur = '';
  for (let i = 0; i < parts.length; i++) {
    cur = i === 0 ? parts[0] : cur + '\\' + parts[i];
    // drive root row may be stored as "H:\" or "H:" — try both
    const candidates = i === 0 ? [cur, cur + '\\'] : [cur];
    const [rows] = await db.connection.query(
      `SELECT id FROM folder_tree WHERE folder_id IN (${candidates.map(() => '?').join(',')}) LIMIT 1`, candidates);
    if (rows.length) { parentId = rows[0].id; continue; }
    await db.connection.execute(
      `INSERT IGNORE INTO folder_tree (folder_id, folder_name, file_count, total_size, recursive_count, recursive_size, depth, parent_id)
       VALUES (?, ?, 0, 0, 0, 0, ?, ?)`, [cur, parts[i], i + 1, parentId]);
    const [r2] = await db.connection.query('SELECT id FROM folder_tree WHERE folder_id = ? LIMIT 1', [cur]);
    parentId = r2[0]?.id ?? null;
  }
  return parentId;
}

export async function rescanFolderOneLevel(db, folderId, { removeMissing = false } = {}) {
  const fid = parseInt(folderId, 10);
  const [folderRow] = await db.connection.query('SELECT id, folder_id, depth FROM folder_tree WHERE id = ?', [fid]);
  if (!folderRow.length) return { error: 'Folder not found' };
  const folderPath = folderRow[0].folder_id;
  const folderDepth = parseInt(folderRow[0].depth, 10) || folderPath.split('\\').filter(Boolean).length;
  let entries;
  try { entries = await fs.promises.readdir(folderPath, { withFileTypes: true }); }
  catch (err) { return { error: `Cannot read folder: ${err.message}`, path: folderPath }; }

  const diskFiles = new Map(); const diskDirs = [];
  for (const e of entries) {
    try {
      if (e.isDirectory()) { diskDirs.push(e.name); continue; }
      if (!e.isFile()) continue;
      const st = await fs.promises.stat(path.join(folderPath, e.name));
      let ext = (e.name.match(/\.([^.]+)$/) || [, ''])[1].slice(0, 255);
      diskFiles.set(e.name, { size: st.size, mtime: toSql(st.mtime), atime: toSql(st.atime), ctime: toSql(st.ctime), extension: ext });
    } catch {}
  }
  const [dbFiles] = await db.connection.query('SELECT id, name, size, mtime FROM scanned_files WHERE folder_id_int = ?', [fid]);
  const dbByName = new Map(dbFiles.map(f => [f.name, f]));
  let added = 0, updated = 0, removed = 0, foldersAdded = 0;
  const missing = dbFiles.filter(r => !diskFiles.has(r.name));
  if (removeMissing && missing.length) {
    await db.archiveDeletedFiles(missing.map(f => ({ id: f.id, name: f.name, path: folderPath + '\\' + f.name, size: f.size, hash: null, extension: null })), 'daily-rescan');
    const ids = missing.map(f => f.id);
    for (let i = 0; i < ids.length; i += 500) {
      const b = ids.slice(i, i + 500);
      await db.connection.query(`DELETE FROM scanned_files WHERE id IN (${b.map(() => '?').join(',')})`, b);
      removed += b.length;
    }
  }
  for (const [name, m] of diskFiles) {
    const ex = dbByName.get(name);
    if (!ex) {
      await db.connection.execute(
        `INSERT INTO scanned_files (name, size, hash, quick_hash, extension, mtime, atime, ctime, scan_id, folder_id_int)
         VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, NULL, ?)`, [name, m.size, m.extension, m.mtime, m.atime, m.ctime, fid]);
      added++;
    } else {
      const oldM = ex.mtime ? new Date(ex.mtime).getTime() : null;
      const newM = m.mtime ? new Date(m.mtime + 'Z').getTime() : null;
      if (Number(ex.size) !== Number(m.size) || oldM !== newM) {
        await db.connection.execute(`UPDATE scanned_files SET size = ?, extension = ?, mtime = ?, atime = ?, ctime = ? WHERE id = ?`,
          [m.size, m.extension, m.mtime, m.atime, m.ctime, ex.id]);
        updated++;
      }
    }
  }
  const [kids] = await db.connection.query('SELECT folder_name FROM folder_tree WHERE parent_id = ?', [fid]);
  const have = new Set(kids.map(c => c.folder_name));
  for (const d of diskDirs) {
    if (have.has(d)) continue;
    try {
      const [ins] = await db.connection.execute(
        `INSERT IGNORE INTO folder_tree (folder_id, folder_name, file_count, total_size, recursive_count, recursive_size, depth, parent_id)
         VALUES (?, ?, 0, 0, 0, 0, ?, ?)`, [folderPath.replace(/\\$/, '') + '\\' + d, d, folderDepth + 1, fid]);
      if (ins.affectedRows > 0) foldersAdded++;
    } catch {}
  }
  return { success: true, path: folderPath, folderId: fid, added, updated, removed, missingOnDisk: missing.length, foldersAdded };
}

/** Recursive BFS rescan + refreshFolderStats (same as POST /api/folder-tree/rescan recursive). */
export async function rescanFolderRecursive(db, folderPath, { maxFolders = 20000, removeMissing = false } = {}) {
  const fid = await ensureFolderPath(db, folderPath);
  if (!fid) return { error: 'Could not resolve folder in folder_tree', path: folderPath };
  const totals = { folderId: fid, added: 0, updated: 0, removed: 0, missingOnDisk: 0, foldersAdded: 0, foldersScanned: 0, foldersSkipped: 0 };
  const queue = [fid]; const seen = new Set();
  while (queue.length && totals.foldersScanned < maxFolders) {
    const cur = queue.shift();
    if (seen.has(cur)) continue; seen.add(cur);
    const r = await rescanFolderOneLevel(db, cur, { removeMissing });
    if (r.error) { if (cur === fid) return { ...totals, error: r.error }; totals.foldersSkipped++; continue; }
    for (const k of ['added', 'updated', 'removed', 'missingOnDisk', 'foldersAdded']) totals[k] += r[k];
    totals.foldersScanned++;
    const [ch] = await db.connection.query('SELECT id FROM folder_tree WHERE parent_id = ?', [cur]);
    ch.forEach(c => { if (!seen.has(c.id)) queue.push(c.id); });
  }
  totals.truncated = queue.length > 0;
  await db.refreshFolderStats(fid);
  const [[row]] = await db.connection.query('SELECT recursive_count, recursive_size FROM folder_tree WHERE id = ?', [fid]);
  totals.recursiveCount = Number(row?.recursive_count || 0);
  totals.recursiveSizeGB = Number((Number(row?.recursive_size || 0) / 1024 ** 3).toFixed(2));
  return totals;
}
