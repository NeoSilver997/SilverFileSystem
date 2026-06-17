import { DatabaseManager } from '../lib/database.js';
import { FaceDetector } from '../lib/face-detector.js';
import fs from 'fs/promises';

const BATCH = 500;
const MIN_CONF = 0.8;

const db = new DatabaseManager({ host:'localhost', port:13306, user:'silver_user', password:'Ps33TAdmin55.', database:'silver_files_db' });
await db.connect();

const fd = new FaceDetector();
const namedGroups = await fd.loadNamedGroups(db);
console.log('Named groups:', namedGroups.length);

let totalFaces = 0, totalScanned = 0, totalBatch = 0;

while (true) {
  const [rows] = await db.connection.execute(`
    SELECT sf.id, sf.name, sf.size, sf.extension, ft.folder_id
    FROM scanned_files sf
    LEFT JOIN folder_tree ft ON sf.folder_id_int = ft.id
    LEFT JOIN photo_metadata pm ON sf.id = pm.file_id
    LEFT JOIN detected_faces df ON sf.id = df.file_id
    WHERE sf.extension IN ('jpg','jpeg','heic')
    AND sf.size > 500000
    AND (pm.camera_make = 'HTC' OR pm.camera_make = 'Apple')
    AND df.id IS NULL
    ORDER BY sf.id DESC
    LIMIT ${BATCH}
  `);

  if (rows.length === 0) break;

  totalBatch++;
  console.log('\nBatch ' + totalBatch + ': ' + rows.length + ' photos');

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const filePath = r.folder_id + '\\' + r.name;

    try {
      const exists = await fs.access(filePath).then(() => true).catch(() => false);
      if (!exists) continue;

      const result = await fd.detect(filePath);
      const faces = (result.faces || []).filter(f => f.confidence >= MIN_CONF);
      totalScanned++;

      if (faces.length > 0) {
        const filtered = { ...result, faces, summary: { ...result.summary, faceCount: faces.length } };
        await db.storeDetectedFaces(r.id, filtered);

        for (const face of faces) {
          if (face.phash) {
            const gid = fd.findMatchingGroup(face.phash, namedGroups);
            if (gid) {
              await db.connection.execute('UPDATE detected_faces SET face_group_id = ? WHERE file_id = ? AND face_index = ?', [gid, r.id, face.index]);
              const [cnt] = await db.connection.execute('SELECT COUNT(*) as c FROM detected_faces WHERE face_group_id = ?', [gid]);
              await db.connection.execute('UPDATE face_groups SET face_count = ? WHERE id = ?', [cnt[0].c, gid]);
            }
          }
        }
        totalFaces += faces.length;
      }

      process.stdout.write('\r  Batch ' + totalBatch + ' [' + (i+1) + '/' + rows.length + '] faces=' + totalFaces + ' scanned=' + totalScanned);
    } catch (e) {}
  }
  console.log('');
}

const [total] = await db.connection.execute('SELECT COUNT(*) as c FROM detected_faces');
console.log('\n=== Done ===');
console.log('Batches:', totalBatch);
console.log('Photos scanned:', totalScanned);
console.log('Faces found:', totalFaces);
console.log('DB total:', total[0].c);

await db.close();
