import fs from 'fs';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
dotenv.config({ quiet: true });

const THUMB_JOB = '4afc81d4bcdf2860';
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
}, secret, { expiresIn: '12h' });
const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')}`;
  console.log(line);
  fs.appendFileSync('logs/daily-pipeline-chain.log', line + '\n');
}

log('watching thumb job', THUMB_JOB);
let lastMsg = '';
while (true) {
  const j = await (await fetch('http://127.0.0.1:4001/api/jobs/' + THUMB_JOB, { headers })).json();
  const msg = `${j.status} ${j.percent}% ${j.done}/${j.total} ${j.message || ''}`;
  if (msg !== lastMsg) { log('thumb', msg); lastMsg = msg; }
  if (j.status === 'error' || j.status === 'cancelled') {
    log('thumb failed, not chaining', j.error || j.message);
    process.exit(1);
  }
  if (j.status === 'done') {
    log('thumb done, enqueue embed+classify');
    let r = await fetch('http://127.0.0.1:4001/api/daily-pipeline', {
      method: 'POST', headers,
      body: JSON.stringify({ limit: 10000, stages: 'embed', noRescan: true })
    });
    const embedJob = await r.json();
    log('embed', r.status, embedJob);
    r = await fetch('http://127.0.0.1:4001/api/daily-pipeline', {
      method: 'POST', headers,
      body: JSON.stringify({ limit: 10000, stages: 'classify,missing-report', noRescan: true })
    });
    const clsJob = await r.json();
    log('classify', r.status, clsJob);
    fs.writeFileSync('tmp/_last_daily_pipeline_jobs.json', JSON.stringify({
      at: new Date().toISOString(),
      thumbJobId: THUMB_JOB,
      embedJobId: embedJob.jobId,
      classifyJobId: clsJob.jobId,
      links: {
        thumb: 'https://medialib2.tcghk.trade/jobs?id=' + THUMB_JOB,
        embed: 'https://medialib2.tcghk.trade/jobs?id=' + embedJob.jobId,
        classify: 'https://medialib2.tcghk.trade/jobs?id=' + clsJob.jobId
      }
    }, null, 2));
    process.exit(0);
  }
  await new Promise(x => setTimeout(x, 15000));
}
