import { parentPort, workerData } from 'worker_threads';
import { FaceDetector } from '../lib/face-detector.js';

const detector = new FaceDetector();
const { items, minConfidence } = workerData;

async function process() {
  const results = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      const result = await detector.detect(item.filePath);
      const highConfFaces = (result.faces || []).filter(f => f.confidence >= minConfidence);
      results.push({
        ...result,
        filePath: item.filePath,
        fileId: item.fileId,
        name: item.name,
        faces: highConfFaces,
        summary: { ...result.summary, faceCount: highConfFaces.length }
      });
    } catch (e) {
      results.push({ success: false, faces: [], filePath: item.filePath, fileId: item.fileId, name: item.name, error: e.message });
    }
    if (i % 5 === 0) {
      parentPort.postMessage({ type: 'progress', current: i + 1, total: items.length });
    }
  }
  parentPort.postMessage({ type: 'done', results });
}

process();
