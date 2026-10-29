/**
 * Enqueue split pipeline batches: thumb-hash / embed / classify.
 * Each job ~batchSize images; up to maxJobsPerType queued per type.
 * Read-only on user files; never moves/deletes.
 */
import { createJob, list as listJobs } from './job-progress.js';

export const SPLIT_TYPES = {
  'thumb-hash': { stages: ['thumb'], label: 'thumb+hash' },
  embed: { stages: ['embed'], label: 'embed' },
  classify: { stages: ['classify'], label: 'classify' }
};

/**
 * Count queued+running jobs by type (optionally filtered by pathPrefix in meta).
 */
export function countActiveByType(pathPrefix = null) {
  const active = listJobs({ limit: 500, includeOlder: true }).filter(
    (j) => j.status === 'queued' || j.status === 'running'
  );
  const out = Object.create(null);
  for (const t of Object.keys(SPLIT_TYPES)) out[t] = 0;
  for (const j of active) {
    if (!SPLIT_TYPES[j.type]) continue;
    if (pathPrefix) {
      const pp = (j.meta && j.meta.pathPrefix) || '';
      const want = String(pathPrefix).replace(/\\+$/, '').toLowerCase();
      const have = String(pp).replace(/\\+$/, '').toLowerCase();
      if (want && have && !have.startsWith(want) && want !== have) continue;
    }
    out[j.type] = (out[j.type] || 0) + 1;
  }
  return { active, counts: out };
}

/**
 * Build params for a split job.
 */
export function buildSplitParams({
  type,
  pathPrefix,
  offset = 0,
  batchSize = 500,
  allImages = true,
  skipRecycle = true,
  needOnly = true,
  dryRun = false
} = {}) {
  const spec = SPLIT_TYPES[type];
  if (!spec) throw new Error('Unknown split type: ' + type);
  return {
    limit: batchSize,
    offset,
    batchSize,
    stages: spec.stages,
    noRescan: true,
    allImages: !!allImages,
    dryRun: !!dryRun,
    pathPrefix: pathPrefix || null,
    skipRecycle: skipRecycle !== false,
    needOnly: needOnly !== false
  };
}

/**
 * Enqueue up to maxJobsPerType jobs for each requested type.
 * Offsets advance by batchSize; skips slots already covered by active jobs of same type+prefix.
 * @returns {{ submitted: object[], skipped: object[], activeCounts: object }}
 */
export function enqueueSplitBatches({
  pathPrefix,
  types = Object.keys(SPLIT_TYPES),
  batchSize = 500,
  maxJobsPerType = 10,
  startOffset = 0,
  allImages = true,
  skipRecycle = true,
  needOnly = true,
  dryRun = false,
  createdBy = 'pipeline-batch-enqueue'
} = {}) {
  const bs = Math.max(1, Math.min(5000, parseInt(batchSize, 10) || 500));
  const maxJ = Math.max(1, Math.min(50, parseInt(maxJobsPerType, 10) || 10));
  const { counts: activeCounts, active } = countActiveByType(pathPrefix);
  const submitted = [];
  const skipped = [];

  for (const type of types) {
    if (!SPLIT_TYPES[type]) {
      skipped.push({ type, reason: 'unknown type' });
      continue;
    }
    const already = activeCounts[type] || 0;
    const toAdd = Math.max(0, maxJ - already);
    if (toAdd === 0) {
      skipped.push({ type, reason: 'already at maxJobsPerType', already, maxJobsPerType: maxJ });
      continue;
    }
    // Collect offsets already used by active jobs of this type+prefix
    const usedOffsets = new Set();
    for (const j of active) {
      if (j.type !== type) continue;
      const off = Number(j.meta?.offset);
      if (Number.isFinite(off)) usedOffsets.add(off);
    }
    let offset = Math.max(0, parseInt(startOffset, 10) || 0);
    let added = 0;
    let guard = 0;
    while (added < toAdd && guard < maxJ * 20) {
      guard++;
      if (usedOffsets.has(offset)) {
        offset += bs;
        continue;
      }
      const params = buildSplitParams({
        type, pathPrefix, offset, batchSize: bs, allImages, skipRecycle, needOnly, dryRun
      });
      const jobId = createJob({
        type,
        total: bs,
        meta: {
          kind: type,
          stages: SPLIT_TYPES[type].stages.join('+'),
          label: SPLIT_TYPES[type].label,
          limit: bs,
          offset,
          batchSize: bs,
          pathPrefix: pathPrefix || null,
          skipRecycle: skipRecycle !== false,
          needOnly: needOnly !== false,
          allImages: !!allImages
        },
        params,
        createdBy
      });
      submitted.push({ jobId, type, offset, batchSize: bs, reviewUrl: '/jobs?id=' + jobId });
      usedOffsets.add(offset);
      offset += bs;
      added++;
    }
  }

  return { submitted, skipped, activeCounts, batchSize: bs, maxJobsPerType: maxJ, pathPrefix };
}

export default { SPLIT_TYPES, countActiveByType, buildSplitParams, enqueueSplitBatches };
