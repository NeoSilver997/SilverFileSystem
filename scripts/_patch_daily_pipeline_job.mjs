import fs from 'fs';

let s = fs.readFileSync('server.js', 'utf8');

if (!s.includes("daily-pipeline-job.js")) {
  const imp = "import { runExtractPhotoMetaJob } from './lib/extract-photo-meta-job.js';";
  if (!s.includes(imp)) throw new Error('missing extract import');
  s = s.replace(imp, imp + "\r\nimport { runDailyPipelineJob } from './lib/daily-pipeline-job.js';");
}

if (!s.includes("type === 'daily-pipeline'")) {
  const re = /  throw new Error\('Unknown job type: ' \+ type\);\r?\n\}\);/;
  if (!re.test(s)) throw new Error('throw anchor missing');
  const block =
`  if (type === 'daily-pipeline') {
    return runDailyPipelineJob({
      db,
      jobId,
      params,
      updateJob,
      isCancelled: isJobCancelled,
      completeJob
    });
  }

  throw new Error('Unknown job type: ' + type);
});`;
  s = s.replace(re, block);
}

if (!s.includes("app.post('/api/daily-pipeline'")) {
  const apiAnchor = "app.post('/api/photo-meta/extract', requireAuthWrapper, requirePhotoPermission, async (req, res) => {";
  if (!s.includes(apiAnchor)) throw new Error('api anchor missing');
  const api = `
// Daily AI pipeline as durable /jobs queue work (rescan → exif → thumb → embed → classify)
app.post('/api/daily-pipeline', requireAuthWrapper, requirePhotoPermission, async (req, res) => {
  try {
    const body = req.body || {};
    const params = {
      limit: body.limit,
      offset: body.offset,
      batchSize: body.batchSize ?? body.batch_size,
      stages: body.stages ?? body.stage,
      noRescan: !!body.noRescan || !!body.no_rescan,
      allImages: !!body.allImages || !!body.all_images,
      dryRun: !!body.dryRun || !!body.dry_run
    };
    const stagesLabel = Array.isArray(params.stages)
      ? params.stages.join('+')
      : (params.stages || 'all');
    const jobId = createJob({
      type: 'daily-pipeline',
      total: 0,
      meta: {
        kind: 'daily-pipeline',
        stages: stagesLabel,
        limit: params.limit || 10000,
        offset: params.offset || 0,
        batchSize: params.batchSize || null
      },
      params,
      createdBy: req.user?.username || req.user?.id || null
    });
    res.status(202).json({
      jobId,
      status: 'queued',
      type: 'daily-pipeline',
      reviewUrl: '/jobs?id=' + jobId
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

`;
  s = s.replace(apiAnchor, api + apiAnchor);
}

fs.writeFileSync('server.js', s);
console.log({
  import: s.includes('daily-pipeline-job.js'),
  runner: s.includes("type === 'daily-pipeline'"),
  api: s.includes("app.post('/api/daily-pipeline'")
});
