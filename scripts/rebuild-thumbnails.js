import 'dotenv/config';
import { DatabaseManager } from './lib/database.js';
import { access } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
const execFileAsync = promisify(execFile);

const db = new DatabaseManager();
await db.connect();

console.log('=== Rebuilding thumbnails with aspect-ratio padding ===\n');

const [faces] = await db.connection.execute(`
  SELECT fv.id, fv.file_id, fv.face_index, fv.bbox_x, fv.bbox_y, fv.bbox_width, fv.bbox_height,
         sf.name as file_name, ft.folder_id as folder_path
  FROM faces_v2 fv
  JOIN scanned_files sf ON fv.file_id = sf.id
  LEFT JOIN folder_tree ft ON sf.folder_id_int = ft.id
  WHERE fv.thumbnail IS NOT NULL AND fv.status != 'ignored'
  ORDER BY fv.id
`);

console.log(`Found ${faces.length} faces to rebuild thumbnails`);

let rebuilt = 0;
let errors = 0;
let skipped = 0;

for (let i = 0; i < faces.length; i++) {
  const f = faces[i];
  const folderPath = (f.folder_path || '').replace(/[\\\/]$/, '');
  const fullPath = folderPath ? folderPath + '\\' + f.file_name : f.file_name;

  try {
    await access(fullPath);
  } catch {
    skipped++;
    continue;
  }

  try {
    // Use Python to rebuild thumbnail with new padding logic
    const pythonScript = `
import cv2, sys, json, base64, numpy as np
img = cv2.imread(sys.argv[1])
if img is None:
    try:
        from PIL import Image
        import pillow_heif
        pillow_heif.register_heif_opener()
        pil_img = Image.open(sys.argv[1])
        if pil_img.mode != 'RGB': pil_img = pil_img.convert('RGB')
        img = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)
    except: print(json.dumps({"error":"Cannot read"})); sys.exit(0)
h, w = img.shape[:2]
# Simple center crop to square with padding
size = min(w, h)
x = (w - size) // 2
y = (h - size) // 2
crop = img[y:y+size, x:x+size]
# Add 20% padding
pad = int(size * 0.2)
padded = np.zeros((size + pad*2, size + pad*2, 3), dtype=np.uint8)
padded[pad:pad+size, pad:pad+size] = crop
thumb = cv2.resize(padded, (128, 128))
_, buf = cv2.imencode('.jpg', thumb, [cv2.IMWRITE_JPEG_QUALITY, 85])
print(base64.b64encode(buf).decode())
`;

    const { stdout } = await execFileAsync('python', ['-c', pythonScript, fullPath], {
      timeout: 10000,
      encoding: 'utf8'
    });

    const thumbB64 = stdout.trim();
    if (thumbB64 && thumbB64.length > 100 && !thumbB64.includes('error')) {
      const thumbBuf = Buffer.from(thumbB64, 'base64');
      await db.connection.execute(
        'UPDATE faces_v2 SET thumbnail = ? WHERE id = ?',
        [thumbBuf, f.id]
      );
      rebuilt++;
    } else {
      errors++;
    }
  } catch (e) {
    errors++;
  }

  if ((i + 1) % 100 === 0) {
    console.log(`  Progress: ${i + 1}/${faces.length} (rebuilt: ${rebuilt}, errors: ${errors}, skipped: ${skipped})`);
  }
}

console.log(`\n=== DONE ===`);
console.log(`Rebuilt: ${rebuilt}`);
console.log(`Errors: ${errors}`);
console.log(`Skipped (file not found): ${skipped}`);

await db.close();
