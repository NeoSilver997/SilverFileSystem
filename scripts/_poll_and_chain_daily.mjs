import fs from 'fs';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
dotenv.config({ quiet: true });
const secret = process.env.JWT_SECRET;
const conn = await mysql.createConnection({
  host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME
});
const [users] = await conn.execute('SELECT id, username FROM users WHERE is_enabled = 1 LIMIT 1');
await conn.end();
const token = jwt.sign({
  id: users[0].id, username: users[0].username,
  can_view_photos: true, can_view_music: true, can_view_videos: true
}, secret, { expiresIn: '6h' });
const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

const keep = '4afc81d4bcdf2860';
let last = null;
for (let i = 0; i < 30; i++) {
  const r = await fetch('http://127.0.0.1:4001/api/jobs/' + keep, { headers });
  last = await r.json();
  console.log('poll', last.status, (last.percent ?? '?') + '%', (last.done ?? '?') + '/' + (last.total ?? '?'), '|', (last.message || '').slice(0, 140));
  if (last.status === 'done' || last.status === 'error' || last.status === 'cancelled') break;
  const msg = last.message || '';
  if (msg.includes('Thumb') || msg.includes('EXIF') || msg.includes('Selecting') || (last.done || 0) > 0) {
    // wait a couple more samples if still early selecting
    if (msg.includes('Thumb') || (last.done || 0) > 0 || msg.includes('EXIF done') || msg.includes('done')) break;
  }
  await new Promise(x => setTimeout(x, 5000));
}

// If still rescanning after wait, report and don't enqueue embed yet
const readyForNext = last && (last.status === 'done' || (last.message || '').includes('Thumb') || (last.message || '').includes('EXIF') || (last.done || 0) > 0 || last.status === 'error');

let embedJob = null, clsJob = null;
if (last?.status === 'done') {
  // enqueue embed then classify
  let r = await fetch('http://127.0.0.1:4001/api/daily-pipeline', {
    method: 'POST', headers,
    body: JSON.stringify({ limit: 10000, stages: 'embed', noRescan: true })
  });
  embedJob = await r.json();
  console.log('enqueue embed', r.status, embedJob);
  r = await fetch('http://127.0.0.1:4001/api/daily-pipeline', {
    method: 'POST', headers,
    body: JSON.stringify({ limit: 10000, stages: 'classify,missing-report', noRescan: true })
  });
  clsJob = await r.json();
  console.log('enqueue classify', r.status, clsJob);
} else {
  console.log('NOTE: thumb job still in progress — embed/classify will be submitted after it finishes. Concurrent queue=3 so do NOT enqueue embed yet.');
}

// status of cancelled/early jobs
for (const id of ['8f9643ccedff4c8a', '4b3b033a83b1864a']) {
  const j = await (await fetch('http://127.0.0.1:4001/api/jobs/' + id, { headers })).json();
  console.log('other', id.slice(0,8), j.status, (j.message || '').slice(0, 100), j.result ? Object.keys(j.result) : null);
}

fs.writeFileSync('tmp/_last_daily_pipeline_jobs.json', JSON.stringify({
  at: new Date().toISOString(),
  thumbJob: { id: keep, status: last?.status, message: last?.message, done: last?.done, total: last?.total },
  embedJob, clsJob,
  note: 'JOB_MAX_CONCURRENT=3; cancelled premature embed; early classify may have completed'
}, null, 2));
