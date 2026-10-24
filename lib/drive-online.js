/**
 * Drive reachability helpers for missing-file deletion.
 *
 * Motivating case: mapped P: (NAS) often goes offline. When a drive letter
 * root (e.g. P:\) is unreachable, fs.access() fails for every path on that
 * volume and would wipe scanned_files / archive "deleted" rows incorrectly.
 * Guard: if X:\ is not accessible, skip missing-file deletion for that drive.
 */

import fs from 'fs';

/** @param {string} filePath */
export function getWindowsDriveRoot(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  const m = filePath.trim().match(/^([A-Za-z]):[\\/]/);
  if (m) return m[1].toUpperCase() + ':\\';
  return null;
}

/**
 * Sync check (short). Prefer isDriveRootAccessibleAsync for network drives.
 * Non-drive-letter paths (UNC, relative) return true (no skip).
 * @param {string} filePath
 */
export function isDriveRootAccessible(filePath) {
  const root = getWindowsDriveRoot(filePath);
  if (!root) return true;
  try {
    return fs.existsSync(root);
  } catch {
    return false;
  }
}

/**
 * @param {string} filePath
 * @param {number} [timeoutMs=3000]
 * @returns {Promise<boolean>}
 */
export function isDriveRootAccessibleAsync(filePath, timeoutMs = 3000) {
  const root = getWindowsDriveRoot(filePath);
  if (!root) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    fs.access(root, fs.constants.F_OK, (err) => {
      clearTimeout(timer);
      resolve(!err);
    });
  });
}

/**
 * Cache drive status while filtering a batch of paths/objects.
 * @param {Array<string|{path?:string,folder_path?:string}>} items
 * @param {{ log?: Function, timeoutMs?: number }} [opts]
 */
export async function partitionByDriveOnline(items, opts = {}) {
  const log = opts.log || console.warn;
  const timeoutMs = opts.timeoutMs ?? 3000;
  /** @type {Map<string, boolean>} */
  const driveStatus = new Map();
  const online = [];
  const skippedOffline = [];

  for (const item of items) {
    const pathStr = typeof item === 'string'
      ? item
      : (item?.path || item?.folder_path || item?.folderPath || '');
    const root = getWindowsDriveRoot(pathStr);
    if (!root) {
      online.push(item);
      continue;
    }
    if (!driveStatus.has(root)) {
      const ok = await isDriveRootAccessibleAsync(pathStr, timeoutMs);
      driveStatus.set(root, ok);
      if (!ok) {
        log('[drive-online] Drive ' + root + ' offline/unreachable — skipping missing-file deletion for this volume (motivating case: mapped P: NAS).');
      }
    }
    if (driveStatus.get(root)) online.push(item);
    else skippedOffline.push(item);
  }

  return { online, skippedOffline, driveStatus };
}

/**
 * Sync helper for CLI / one-shot checks.
 * @param {string} filePath
 * @param {{ log?: Function }} [opts]
 * @returns {boolean} true if caller must NOT mark the path deleted
 */
export function shouldSkipMissingDeletion(filePath, opts = {}) {
  const log = opts.log || console.warn;
  const root = getWindowsDriveRoot(filePath);
  if (!root) return false;
  const ok = isDriveRootAccessible(filePath);
  if (!ok) {
    log('[drive-online] Drive ' + root + ' offline/unreachable — not marking deleted: ' + filePath);
  }
  return !ok;
}
