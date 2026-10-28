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
}, secret, { expiresIn: '2h' });
const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

for (const id of ['8f9643ccedff4c8a', '4b3b033a83b1864a']) {
  const r = await fetch('http://127.0.0.1:4001/api/jobs/' + id + '/cancel', { method: 'POST', headers, body: '{}' });
  const j = await r.json().catch(() => ({}));
  console.log('cancel', id, r.status, j.status || j.error || j);
}

const keep = '4afc81d4bcdf2860';
const r = await fetch('http://127.0.0.1:4001/api/jobs/' + keep, { headers });
const j = await r.json();
console.log('keep', j.status, j.percent + '%', j.done + '/' + j.total, j.message);

// Also check concurrency via env
console.log('JOB_MAX_CONCURRENT', process.env.JOB_MAX_CONCURRENT || '(default 1)');
