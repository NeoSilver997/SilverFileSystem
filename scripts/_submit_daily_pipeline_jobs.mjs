import fs from 'fs';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
dotenv.config({ quiet: true });

const secret = process.env.JWT_SECRET;
if (!secret) { console.error('no JWT'); process.exit(1); }
const conn = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});
const [users] = await conn.execute('SELECT id, username FROM users WHERE is_enabled = 1 LIMIT 1');
await conn.end();
if (!users[0]) { console.error('no user'); process.exit(2); }

const token = jwt.sign({
  id: users[0].id, username: users[0].username,
  can_view_photos: true, can_view_music: true, can_view_videos: true
}, secret, { expiresIn: '6h' });
const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

const batches = [
  { stages: 'rescan,exif,thumb', limit: 10000, label: '1/3 rescan+exif+thumb' },
  { stages: 'embed', limit: 10000, noRescan: true, label: '2/3 embed' },
  { stages: 'classify,missing-report', limit: 10000, noRescan: true, label: '3/3 classify+missing' }
];

const submitted = [];
for (const b of batches) {
  const body = { limit: b.limit, stages: b.stages };
  if (b.noRescan) body.noRescan = true;
  const r = await fetch('http://127.0.0.1:4001/api/daily-pipeline', {
    method: 'POST', headers, body: JSON.stringify(body)
  });
  const j = await r.json();
  console.log('enqueue', b.label, r.status, j);
  if (!j.jobId) { console.error('FAILED', j); process.exit(3); }
  submitted.push({ ...b, jobId: j.jobId, reviewUrl: j.reviewUrl || ('/jobs?id=' + j.jobId) });
}

fs.mkdirSync('tmp', { recursive: true });
fs.writeFileSync('tmp/_last_daily_pipeline_jobs.json', JSON.stringify({ submittedAt: new Date().toISOString(), submitted }, null, 2));

// Poll first job briefly
const first = submitted[0].jobId;
for (let i = 0; i < 12; i++) {
  await new Promise((x) => setTimeout(x, 2000));
  const r = await fetch('http://127.0.0.1:4001/api/jobs/' + first, { headers });
  const j = await r.json();
  console.log('poll1', j.status, (j.percent ?? '?') + '%', (j.done ?? '?') + '/' + (j.total ?? '?'), '|', (j.message || '').slice(0, 120));
  if (j.status === 'error' || j.status === 'cancelled') { console.error(j.error || j); break; }
  if (j.status === 'running' && ((j.done || 0) > 0 || (j.message || '').includes('Rescan') || (j.message || '').includes('Selecting') || (j.message || '').includes('Thumb') || (j.message || '').includes('EXIF'))) break;
}

const list = await (await fetch('http://127.0.0.1:4001/api/jobs?limit=10&includeOlder=1', { headers })).json();
console.log('queue', (list.jobs || []).filter(j => j.type === 'daily-pipeline' || j.status === 'queued' || j.status === 'running')
  .map(j => ({ id: j.id?.slice(0, 8), type: j.type, status: j.status, msg: (j.message || '').slice(0, 60) })));

console.log('SUBMITTED');
for (const s of submitted) {
  console.log(`${s.label}  ${s.jobId}  https://medialib2.tcghk.trade/jobs?id=${s.jobId}`);
}
