import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'face_attrs.py');

export class FaceDetector {
  constructor(config = {}) {
    this.pythonPath = config.pythonPath || 'python';
    this.timeout = config.timeout || 30000;
  }

  async detect(filePath) {
    try {
      const { stdout } = await execFileAsync(this.pythonPath, [SCRIPT_PATH, filePath], {
        timeout: this.timeout,
        maxBuffer: 10 * 1024 * 1024
      });
      return JSON.parse(stdout.trim());
    } catch (err) {
      return {
        success: false, error: err.message,
        faces: [], elapsed: 0, filePath,
        summary: { faceCount: 0, hasFaces: false }
      };
    }
  }

  async detectBatch(filePaths, onProgress) {
    const results = [];
    for (let i = 0; i < filePaths.length; i++) {
      const result = await this.detect(filePaths[i]);
      results.push(result);
      if (onProgress) {
        onProgress({
          current: i + 1, total: filePaths.length,
          filename: path.basename(filePaths[i]),
          faceCount: result.summary?.faceCount || 0,
          elapsed: result.elapsed || 0
        });
      }
    }
    return results;
  }

  groupFaces(allResults) {
    const allFaces = [];
    for (const result of allResults) {
      if (!result.success || !result.faces) continue;
      for (const face of result.faces) {
        allFaces.push({
          ...face,
          filePath: result.filePath,
          filename: path.basename(result.filePath)
        });
      }
    }

    const groups = [];
    const assigned = new Set();

    for (let i = 0; i < allFaces.length; i++) {
      if (assigned.has(i)) continue;

      const group = {
        groupId: groups.length,
        faces: [allFaces[i]],
        primaryThumbnail: allFaces[i].thumbnail
      };
      assigned.add(i);

      for (let j = i + 1; j < allFaces.length; j++) {
        if (assigned.has(j)) continue;

        const dist = this.hammingDistance(
          allFaces[i].perceptual_hash,
          allFaces[j].perceptual_hash
        );

        if (dist <= 8) {
          group.faces.push(allFaces[j]);
          assigned.add(j);
        }
      }

      group.faceCount = group.faces.length;
      group.files = [...new Set(group.faces.map(f => f.filePath))];
      group.label = `Person ${groups.length + 1}`;
      group.dominantGender = this.mode(group.faces.map(f => f.gender));
      group.dominantAge = this.mode(group.faces.map(f => f.age_group));

      groups.push(group);
    }

    groups.sort((a, b) => b.faceCount - a.faceCount);
    groups.forEach((g, i) => g.groupId = i);

    return groups;
  }

  mode(arr) {
    const freq = {};
    for (const v of arr) { if (v) freq[v] = (freq[v] || 0) + 1; }
    return Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  }

  hammingDistance(h1, h2) {
    let xor = BigInt(h1) ^ BigInt(h2);
    let count = 0;
    while (xor) { count++; xor &= xor - 1n; }
    return count;
  }

  // Match a face's phash against known named groups
  // Returns groupId if match found, null otherwise
  findMatchingGroup(facePhash, namedGroups, threshold = 10) {
    if (!facePhash || !namedGroups?.length) return null;

    for (const grp of namedGroups) {
      for (const sampleHash of grp.sampleHashes) {
        if (this.hammingDistance(facePhash, sampleHash) <= threshold) {
          return grp.id;
        }
      }
    }
    return null;
  }

  // Load named groups with their face phashes from DB
  async loadNamedGroups(db) {
    const [groups] = await db.connection.execute(
      'SELECT id, label FROM face_groups WHERE label IS NOT NULL AND label != ""'
    );

    const namedGroups = [];
    for (const grp of groups) {
      const [faces] = await db.connection.execute(
        'SELECT face_descriptor FROM detected_faces WHERE face_group_id = ? AND face_descriptor IS NOT NULL LIMIT 10',
        [grp.id]
      );

      const hashes = [];
      for (const f of faces) {
        const desc = typeof f.face_descriptor === 'string' ? JSON.parse(f.face_descriptor) : f.face_descriptor;
        if (desc?.phash) hashes.push(desc.phash);
      }

      if (hashes.length > 0) {
        namedGroups.push({ id: grp.id, label: grp.label, sampleHashes: hashes });
      }
    }

    return namedGroups;
  }

  hammingDistance(h1, h2) {
    let xor = BigInt(h1) ^ BigInt(h2);
    let count = 0;
    while (xor) { count++; xor &= xor - 1n; }
    return count;
  }
}

export default FaceDetector;
