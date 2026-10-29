/**
 * Durable skip/blacklist for media that should not be retried by daily-pipeline
 * (corrupt / unreadable / confirmed missing on disk).
 * Never deletes or moves user files — only records file_id + reason in DB.
 */
const TABLE_SQL = `
CREATE TABLE IF NOT EXISTS media_skip (
  file_id INT NOT NULL PRIMARY KEY,
  reason VARCHAR(64) NOT NULL,
  stage VARCHAR(32) NULL,
  error VARCHAR(512) NULL,
  path_snapshot VARCHAR(1024) NULL,
  name_snapshot VARCHAR(512) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_reason (reason),
  INDEX idx_stage (stage),
  CONSTRAINT fk_media_skip_file FOREIGN KEY (file_id) REFERENCES scanned_files(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

export async function ensureMediaSkipTable(conn) {
  if (!conn) throw new Error('conn required');
  await conn.execute(TABLE_SQL);
}

/**
 * @param {import('mysql2/promise').Pool|import('mysql2/promise').Connection} conn
 * @param {number[]} fileIds
 * @returns {Promise<Set<number>>}
 */
export async function loadSkippedFileIds(conn, fileIds) {
  const out = new Set();
  if (!conn || !fileIds?.length) return out;
  await ensureMediaSkipTable(conn);
  for (let i = 0; i < fileIds.length; i += 1000) {
    const chunk = fileIds.slice(i, i + 1000);
    const [rows] = await conn.query(
      `SELECT file_id FROM media_skip WHERE file_id IN (${chunk.map(() => '?').join(',')})`,
      chunk
    );
    for (const r of rows) out.add(Number(r.file_id));
  }
  return out;
}

/**
 * Upsert a skip row. reason examples: corrupt, missing_on_disk, unreadable
 */
export async function markMediaSkip(conn, {
  fileId, reason, stage = null, error = null, pathSnapshot = null, nameSnapshot = null
}) {
  if (!conn || !fileId) return;
  await ensureMediaSkipTable(conn);
  await conn.execute(
    `INSERT INTO media_skip (file_id, reason, stage, error, path_snapshot, name_snapshot)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       reason = VALUES(reason),
       stage = VALUES(stage),
       error = VALUES(error),
       path_snapshot = COALESCE(VALUES(path_snapshot), path_snapshot),
       name_snapshot = COALESCE(VALUES(name_snapshot), name_snapshot),
       updated_at = CURRENT_TIMESTAMP`,
    [
      fileId,
      String(reason || 'corrupt').slice(0, 64),
      stage ? String(stage).slice(0, 32) : null,
      error != null ? String(error).slice(0, 512) : null,
      pathSnapshot != null ? String(pathSnapshot).slice(0, 1024) : null,
      nameSnapshot != null ? String(nameSnapshot).slice(0, 512) : null
    ]
  );
}

export function isCorruptThumbError(err) {
  const m = String(err?.message || err || '').toLowerCase();
  return /not a heic|bad seek|unsupported|corrupt|invalid|vips|premature end|unexpected end|input buffer/i.test(m);
}
