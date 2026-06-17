import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INSIGHTFACE_SCRIPT = path.join(__dirname, '..', 'scripts', 'face_insightface.py');
const YUNET_SCRIPT = path.join(__dirname, '..', 'scripts', 'face_yunet.py');
const FALLBACK_SCRIPT = path.join(__dirname, '..', 'scripts', 'face_attrs.py');

export class FaceDetector {
  constructor(config = {}) {
    this.pythonPath = config.pythonPath || 'python';
    this.timeout = config.timeout || 30000;
  }

  async detect(filePath) {
    const scripts = [INSIGHTFACE_SCRIPT, YUNET_SCRIPT, FALLBACK_SCRIPT];
    for (const script of scripts) {
      try {
        const { stdout } = await execFileAsync(this.pythonPath, [script, filePath], {
          timeout: this.timeout,
          maxBuffer: 10 * 1024 * 1024
        });
        const result = JSON.parse(stdout.trim());
        if (result.success) return result;
      } catch (err) {
        continue;
      }
    }
    return {
      success: false, error: 'All detectors failed',
      faces: [], elapsed: 0, filePath,
      summary: { faceCount: 0, hasFaces: false }
    };
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

  cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  hammingDistance(h1, h2) {
    let xor = BigInt(h1) ^ BigInt(h2);
    let count = 0;
    while (xor) { count++; xor &= xor - 1n; }
    return count;
  }

  computeFaceSimilarity(face1, face2) {
    let score = 0;
    let weights = 0;

    const emb1 = face1.face_descriptor?.embedding || face1.embedding;
    const emb2 = face2.face_descriptor?.embedding || face2.embedding;
    if (emb1 && emb2 && emb1.length === emb2.length) {
      const cosSim = this.cosineSimilarity(emb1, emb2);
      score += Math.max(0, cosSim) * 0.7;
      weights += 0.7;
    }

    const phash1 = face1.perceptual_hash || face1.face_descriptor?.phash;
    const phash2 = face2.perceptual_hash || face2.face_descriptor?.phash;
    if (phash1 && phash2) {
      const dist = this.hammingDistance(phash1, phash2);
      const phashScore = Math.max(0, 1 - dist / 72);
      score += phashScore * 0.15;
      weights += 0.15;
    }

    const dhash1 = face1.dhash || face1.face_descriptor?.dhash;
    const dhash2 = face2.dhash || face2.face_descriptor?.dhash;
    if (dhash1 && dhash2) {
      const dist = this.hammingDistance(dhash1, dhash2);
      const dhashScore = Math.max(0, 1 - dist / 64);
      score += dhashScore * 0.1;
      weights += 0.1;
    }

    if (face1.gender && face2.gender && face1.gender !== 'unknown' && face2.gender !== 'unknown') {
      score += (face1.gender === face2.gender ? 1 : 0) * 0.05;
      weights += 0.05;
    }

    if (face1.age_group && face2.age_group) {
      score += (face1.age_group === face2.age_group ? 1 : 0) * 0.05;
      weights += 0.05;
    }

    return weights > 0 ? score / weights : 0;
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
        const sim = this.computeFaceSimilarity(allFaces[i], allFaces[j]);
        if (sim >= 0.6) {
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

  findMatchingGroup(face, namedGroups, threshold = 0.75) {
    if (!namedGroups?.length) return { groupId: null, score: 0 };

    const faceEmbedding = face.face_descriptor?.embedding || face.embedding;
    const facePhash = face.perceptual_hash || face.face_descriptor?.phash;
    const faceDhash = face.dhash || face.face_descriptor?.dhash;

    let bestGroup = null;
    let bestScore = 0;

    for (const grp of namedGroups) {
      const samplesToCheck = grp.masterSample
        ? [grp.masterSample, ...grp.samples.filter(s => s !== grp.masterSample)]
        : grp.samples;

      let maxCosSim = 0;
      let matchCount = 0;

      for (const sample of samplesToCheck) {
        let cosSim = 0;

        if (faceEmbedding && sample.embedding && faceEmbedding.length === sample.embedding.length) {
          cosSim = Math.max(0, this.cosineSimilarity(faceEmbedding, sample.embedding));
        } else if (facePhash && sample.phash) {
          const dist = this.hammingDistance(facePhash, sample.phash);
          cosSim = Math.max(0, 1 - dist / 72);
        }

        if (cosSim > maxCosSim) maxCosSim = cosSim;
        if (cosSim > 0.5) matchCount++;
      }

      if (maxCosSim <= 0) continue;

      // Gender mismatch penalty
      let genderPenalty = 0;
      if (face.gender && grp.masterSample?.gender && face.gender !== 'unknown' && grp.masterSample.gender !== 'unknown') {
        if (face.gender !== grp.masterSample.gender) genderPenalty = 0.15;
      }

      const coverageBonus = Math.min(matchCount / samplesToCheck.length, 1) * 0.05;
      const masterBonus = grp.masterSample ? 0.02 : 0;
      const finalScore = Math.min(1, maxCosSim + coverageBonus + masterBonus - genderPenalty);

      if (finalScore > bestScore && finalScore >= threshold) {
        bestScore = finalScore;
        bestGroup = grp;
      }
    }

    return { groupId: bestGroup ? bestGroup.id : null, score: Math.round(bestScore * 1000) / 1000 };
  }

  async loadNamedGroups(db) {
    const [groups] = await db.connection.execute(
      'SELECT id, label, master_face_id, secondary_face_ids FROM face_groups WHERE label IS NOT NULL AND label != ""'
    );

    const namedGroups = [];
    for (const grp of groups) {
      const masterId = grp.master_face_id;
      let secondaryIds = [];
      try {
        const parsed = typeof grp.secondary_face_ids === 'string' ? JSON.parse(grp.secondary_face_ids) : grp.secondary_face_ids;
        secondaryIds = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
      } catch { secondaryIds = []; }
      const allIds = [masterId, ...secondaryIds].filter(Boolean);

      if (allIds.length === 0) continue;

      const placeholders = allIds.map(() => '?').join(',');
      const [faces] = await db.connection.execute(
        `SELECT id, face_descriptor, gender, age FROM detected_faces WHERE id IN (${placeholders}) AND face_descriptor IS NOT NULL`,
        allIds
      );

      const samples = [];
      let masterSample = null;

      for (const f of faces) {
        const desc = typeof f.face_descriptor === 'string' ? JSON.parse(f.face_descriptor) : f.face_descriptor;
        if (!desc) continue;

        let ageGroup = null;
        if (f.age != null) {
          if (f.age > 25) ageGroup = 'adult';
          else if (f.age > 18) ageGroup = 'young_adult';
          else if (f.age > 12) ageGroup = 'teen';
          else ageGroup = 'child';
        }

        const sample = {
          phash: desc.phash || null,
          dhash: desc.dhash || null,
          embedding: desc.embedding || null,
          gender: f.gender || null,
          age_group: ageGroup
        };
        samples.push(sample);

        if (masterId && f.id === masterId) {
          masterSample = sample;
        }
      }

      if (samples.length > 0) {
        namedGroups.push({ id: grp.id, label: grp.label, samples, masterSample, secondaryCount: secondaryIds.length });
      }
    }

    return namedGroups;
  }
}

export default FaceDetector;
