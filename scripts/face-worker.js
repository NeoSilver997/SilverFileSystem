import { parentPort, workerData } from 'worker_threads';
import { FaceDetector } from '../lib/face-detector.js';
import { access } from 'fs/promises';

const detector = new FaceDetector({ model: workerData.model || 'antelopev2' });
const { items, minConfidence, model } = workerData;

async function process() {
  const t0 = Date.now();
  let totalFaces = 0;
  let totalErrors = 0;
  let totalFiles = 0;
  let totalSkipped = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const fileStart = Date.now();
    try {
      try {
        await access(item.filePath);
      } catch {
        totalFiles++;
        totalErrors++;
        parentPort.postMessage({ type: 'progress', current: i + 1, total: items.length, name: item.name, faces: 0, elapsed: 0, error: 'File not found', size: item.size });
        continue;
      }

      const result = await detector.detect(item.filePath);
      const highConfFaces = (result.faces || []).filter(f => f.confidence >= minConfidence);
      const lowConfFaces = (result.faces || []).filter(f => f.confidence < minConfidence);
      const elapsed = Date.now() - fileStart;

      totalFiles++;
      totalFaces += highConfFaces.length;
      totalSkipped += lowConfFaces.length;

      const faceDetails = highConfFaces.map(f => ({
        conf: f.confidence,
        gender: f.gender,
        age: f.age_approx,
        quality: f.face_descriptor?.quality_score
      }));

      // Send individual result for immediate DB save
      parentPort.postMessage({
        type: 'result',
        result: {
          ...result,
          filePath: item.filePath,
          fileId: item.fileId,
          name: item.name,
          faces: highConfFaces,
          summary: { ...result.summary, faceCount: highConfFaces.length }
        }
      });

      parentPort.postMessage({
        type: 'progress',
        current: i + 1,
        total: items.length,
        name: item.name,
        faces: highConfFaces.length,
        lowConf: lowConfFaces.length,
        faceDetails,
        elapsed,
        model: result.model || model || 'unknown',
        success: result.success,
        size: item.size
      });
    } catch (e) {
      const elapsed = Date.now() - fileStart;
      totalFiles++;
      totalErrors++;
      parentPort.postMessage({
        type: 'progress',
        current: i + 1,
        total: items.length,
        name: item.name,
        faces: 0,
        elapsed,
        error: e.message,
        size: item.size
      });
    }
  }
  const totalElapsed = Date.now() - t0;
  parentPort.postMessage({ type: 'done', totalFaces, totalErrors, totalFiles, totalSkipped, totalElapsed, modelLoadTime: items.length > 0 ? 0 : 0 });
}

process();
