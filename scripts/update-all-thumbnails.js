import mysql from 'mysql2/promise';
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PYTHON_SCRIPT = path.join(__dirname, 'face_yunet_insightface.py');

async function main() {
  const offset = parseInt(process.argv[2]) || 0;

  const db = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'silverfs'
  });

  console.log('Connected to database');

  const [faces] = await db.execute(`
    SELECT f.id, f.file_id, f.face_index, f.bbox_x, f.bbox_y, f.bbox_width, f.bbox_height,
           ft.folder_id as folder_path, sf.name
    FROM faces_v2 f
    LEFT JOIN scanned_files sf ON f.file_id = sf.id
    LEFT JOIN folder_tree ft ON sf.folder_id_int = ft.id
    WHERE ft.folder_id IS NOT NULL AND sf.name IS NOT NULL
    ORDER BY f.file_id
  `);

  console.log(`Found ${faces.length} faces to update`);

  const worker = spawn('python', [PYTHON_SCRIPT, '--worker', 'buffalo_l'], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let workerReady = false;
  worker.stderr.on('data', (data) => {
    if (data.toString().includes('Model loaded') || data.toString().includes('applied providers')) {
      workerReady = true;
    }
  });

  await new Promise((resolve) => {
    const check = setInterval(() => { if (workerReady) { clearInterval(check); resolve(); } }, 100);
    setTimeout(() => { clearInterval(check); resolve(); }, 30000);
  });

  console.log('Worker ready');

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  const rl = createInterface({ input: worker.stdout });
  const pending = new Map();

  rl.on('line', (line) => {
    try {
      const result = JSON.parse(line);
      const cb = pending.get(result.filePath);
      if (cb) { pending.delete(result.filePath); cb(result); }
    } catch {}
  });

  async function detectFace(filePath) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => { pending.delete(filePath); resolve(null); }, 60000);
      pending.set(filePath, (result) => { clearTimeout(timeout); resolve(result); });
      worker.stdin.write(JSON.stringify({ path: filePath, model: 'buffalo_l' }) + '\n');
    });
  }

  const fileGroups = {};
  for (const face of faces) {
    const filePath = face.folder_path + '\\' + face.name;
    if (!fileGroups[filePath]) fileGroups[filePath] = [];
    fileGroups[filePath].push(face);
  }

  const filePaths = Object.keys(fileGroups);
  const remaining = offset > 0 ? filePaths.slice(offset) : filePaths;
  console.log(`Processing ${remaining.length} unique files (offset=${offset})...`);

  for (let i = 0; i < remaining.length; i++) {
    const filePath = remaining[i];
    const faceRecords = fileGroups[filePath];

    if (i % 100 === 0) {
      console.log(`Progress: ${offset + i}/${filePaths.length} files (${updated} updated, ${skipped} skipped, ${errors} errors)`);
    }

    try {
      const result = await detectFace(filePath);
      if (!result || !result.success || !result.faces || result.faces.length === 0) {
        skipped += faceRecords.length;
        continue;
      }

      for (const faceRec of faceRecords) {
        const matchedFace = result.faces[faceRec.face_index] || result.faces[0];
        if (!matchedFace) { skipped++; continue; }

        const bbox = matchedFace.bbox;
        const thumbB64 = matchedFace.thumbnail;

        if (thumbB64) {
          const thumbBuf = Buffer.from(thumbB64, 'base64');
          await db.execute(
            'UPDATE faces_v2 SET bbox_x=?, bbox_y=?, bbox_width=?, bbox_height=?, thumbnail=? WHERE id=?',
            [bbox.x, bbox.y, bbox.width, bbox.height, thumbBuf, faceRec.id]
          );
          updated++;
        } else {
          await db.execute(
            'UPDATE faces_v2 SET bbox_x=?, bbox_y=?, bbox_width=?, bbox_height=? WHERE id=?',
            [bbox.x, bbox.y, bbox.width, bbox.height, faceRec.id]
          );
          updated++;
        }
      }
    } catch (err) {
      errors += faceRecords.length;
      if (errors <= 5) console.error(`Error for ${filePath}: ${err.message}`);
    }
  }

  const nextOffset = offset + remaining.length;
  console.log(`\nDone! Updated: ${updated}, Skipped: ${skipped}, Errors: ${errors}`);
  if (nextOffset < filePaths.length) {
    console.log(`To resume, run: node scripts/update-all-thumbnails.js ${nextOffset}`);
  }
  worker.stdin.write('QUIT\n');
  worker.kill();
  await db.end();
}

main().catch(console.error);
