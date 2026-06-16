import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import { VLMClient, FastPreClassifier } from './vlm-client.js';

const CATEGORY_FOLDERS = {
  '人物單人': 'people',
  '人物合照': 'people',
  '風景': 'landscapes',
  '動物': 'animals',
  '食物': 'food',
  '收據餐牌資料': 'data',
  '螢幕截圖': 'data',
  '其他': 'other'
};

const COMPRESS_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.webp'];
const MAX_COMPRESS_DIMENSION = 1920;
const COMPRESS_QUALITY = 80;
const DATA_EXPIRY_DAYS = 90;

export class PhotoClassifier {
  constructor(config = {}) {
    this.vlm = new VLMClient(config.vlm || {});
    this.preClassifier = new FastPreClassifier();
    this.outputBase = config.outputBase || config.watchDir || process.env.PHOTO_OUTPUT_DIR || path.join(process.cwd(), 'photo_library');
    this.dryRun = config.dryRun || false;
    this.mode = config.mode || 'fast';
    this.onClassified = config.onClassified || null;
    this.onError = config.onError || null;
  }

  async classifyAndRoute(filePath, exifData = {}) {
    const result = {
      originalPath: filePath,
      filename: path.basename(filePath),
      success: false,
      category: null,
      destinationPath: null,
      compressed: false,
      error: null,
      timing: {}
    };

    try {
      const exists = await fs.access(filePath).then(() => true).catch(() => false);
      if (!exists) {
        result.error = 'File not found';
        return result;
      }

      const t0 = Date.now();
      const preResult = await this.preClassifier.analyze(filePath, exifData);
      result.timing.preClassify = Date.now() - t0;

      let classification;

      if (this.mode === 'fast' && preResult.fastCategory && preResult.confidence >= 0.5) {
        classification = {
          category: preResult.fastCategory,
          subject: preResult.fastCategory === '螢幕截圖' ? 'Screenshot detected by heuristic' : '',
          action: '', background: '', style: '', ai_prompt: '',
          tags: [], mood: '', color_palette: '', lighting: '', camera_angle: '',
          confidence: preResult.confidence
        };
        result.usedFastPath = true;
      } else {
        const vlmMode = this.mode === 'detail' ? 'detail' : 'fast';
        const t1 = Date.now();
        const vlmResult = await this.vlm.classifyImage(filePath, vlmMode);
        result.timing.vlmInference = Date.now() - t1;

        if (!vlmResult.success) {
          result.error = `VLM failed: ${vlmResult.error}`;
          return result;
        }
        classification = vlmResult.classification;
        result.usedFastPath = false;
      }

      result.category = classification.category;
      result.vlmResult = classification;
      result.preAnalysis = {
        dominance: preResult.dominance,
        brightness: preResult.brightness,
        isPortrait: preResult.isPortrait
      };

      if (classification.category === '人物單人' || classification.category === '人物合照') {
        const t2 = Date.now();
        result.faceRegions = await this.extractFaceRegions(filePath, classification);
        result.timing.faceExtraction = Date.now() - t2;
      }

      const dateTaken = exifData.datetime?.taken || exifData.date_taken || new Date();
      const date = new Date(dateTaken);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const subFolder = CATEGORY_FOLDERS[classification.category] || 'other';

      let targetDir;
      if (this.vlm.isDataCategory(classification.category)) {
        targetDir = path.join(this.outputBase, '_data', subFolder);
      } else {
        targetDir = path.join(this.outputBase, subFolder, `${year}`, month);
      }

      if (this.dryRun) {
        result.destinationPath = path.join(targetDir, result.filename);
        result.success = true;
        return result;
      }

      await fs.mkdir(targetDir, { recursive: true });

      let finalPath = path.join(targetDir, result.filename);
      finalPath = await this.resolveConflict(finalPath);

      if (this.vlm.isDataCategory(classification.category)) {
        const ext = path.extname(filePath).toLowerCase();
        if (COMPRESS_EXTENSIONS.includes(ext)) {
          try {
            const compressedPath = finalPath.replace(/\.[^.]+$/, '.webp');
            await this.compressImage(filePath, compressedPath);
            finalPath = compressedPath;
            result.compressed = true;
          } catch (compressErr) {
            await fs.copyFile(filePath, finalPath);
          }
        } else {
          await fs.copyFile(filePath, finalPath);
        }
      } else {
        await fs.copyFile(filePath, finalPath);
      }

      result.destinationPath = finalPath;
      result.success = true;

      if (this.onClassified) {
        await this.onClassified(result, classification, exifData);
      }

    } catch (err) {
      result.error = err.message;
      if (this.onError) {
        this.onError(result, err);
      }
    }

    return result;
  }

  async batchClassify(filePaths, exifDataMap = {}, onProgress) {
    const results = [];
    const total = filePaths.length;

    for (let i = 0; i < total; i++) {
      const filePath = filePaths[i];
      const exif = exifDataMap[filePath] || {};

      const result = await this.classifyAndRoute(filePath, exif);
      results.push(result);

      if (onProgress) {
        onProgress({
          current: i + 1,
          total,
          filename: path.basename(filePath),
          category: result.category,
          success: result.success
        });
      }
    }

    const summary = {
      total,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      categories: {},
      compressed: results.filter(r => r.compressed).length
    };

    for (const r of results) {
      if (r.category) {
        summary.categories[r.category] = (summary.categories[r.category] || 0) + 1;
      }
    }

    return { results, summary };
  }

  async extractFaceRegions(filePath, classification) {
    try {
      const buffer = await fs.readFile(filePath);
      const meta = await sharp(buffer).metadata();
      const w = meta.width;
      const h = meta.height;

      const isPortrait = h > w * 1.3;
      const regions = [];

      if (classification.category === '人物單人') {
        const cx = w * 0.5;
        const cy = isPortrait ? h * 0.3 : h * 0.4;
        const faceW = Math.min(w * 0.4, 500);
        const faceH = faceW * 1.2;

        regions.push({
          label: 'face_main',
          bbox: {
            x: Math.max(0, Math.round(cx - faceW / 2)),
            y: Math.max(0, Math.round(cy - faceH / 2)),
            width: Math.round(faceW),
            height: Math.round(faceH)
          },
          confidence: 0.8
        });
      } else if (classification.category === '人物合照') {
        const persons = classification.subject?.match(/\d+/);
        const count = persons ? parseInt(persons[0]) : 2;

        for (let i = 0; i < Math.min(count, 6); i++) {
          const cx = w * (0.2 + (i * 0.6 / Math.max(count - 1, 1)));
          const cy = isPortrait ? h * 0.3 : h * 0.4;
          const faceW = Math.min(w * 0.25, 350);
          const faceH = faceW * 1.2;

          regions.push({
            label: `face_${i + 1}`,
            bbox: {
              x: Math.max(0, Math.round(cx - faceW / 2)),
              y: Math.max(0, Math.round(cy - faceH / 2)),
              width: Math.round(faceW),
              height: Math.round(faceH)
            },
            confidence: 0.6
          });
        }
      }

      for (const region of regions) {
        const { x, y, width, height } = region.bbox;
        try {
          const thumb = await sharp(buffer)
            .extract({ left: x, top: y, width: Math.min(width, w - x), height: Math.min(height, h - y) })
            .resize(128, 128, { fit: 'cover' })
            .jpeg({ quality: 80 })
            .toBuffer();
          region.thumbnail = thumb.toString('base64');
        } catch {
          region.thumbnail = null;
        }
      }

      return regions;
    } catch {
      return [];
    }
  }

  async compressImage(inputPath, outputPath) {
    const stat = await fs.stat(inputPath);
    const image = sharp(inputPath);
    const meta = await image.metadata();

    let pipeline = image;

    if (meta.width > MAX_COMPRESS_DIMENSION || meta.height > MAX_COMPRESS_DIMENSION) {
      pipeline = pipeline.resize(MAX_COMPRESS_DIMENSION, MAX_COMPRESS_DIMENSION, {
        fit: 'inside',
        withoutEnlargement: true
      });
    }

    pipeline = pipeline.webp({ quality: COMPRESS_QUALITY });

    await pipeline.toFile(outputPath);

    const newStat = await fs.stat(outputPath);
    return {
      originalSize: stat.size,
      compressedSize: newStat.size,
      ratio: ((1 - newStat.size / stat.size) * 100).toFixed(1) + '%'
    };
  }

  async resolveConflict(filePath) {
    try {
      await fs.access(filePath);
      const ext = path.extname(filePath);
      const base = path.basename(filePath, ext);
      const dir = path.dirname(filePath);
      let counter = 1;
      let newPath;
      do {
        newPath = path.join(dir, `${base}_${counter}${ext}`);
        counter++;
      } while (await fs.access(newPath).then(() => true).catch(() => false));
      return newPath;
    } catch {
      return filePath;
    }
  }

  async cleanupExpiredData(expiryDays = DATA_EXPIRY_DAYS) {
    const dataDir = path.join(this.outputBase, '_data');
    try {
      await fs.access(dataDir);
    } catch {
      return { cleaned: 0, freed: 0 };
    }

    const cutoff = Date.now() - expiryDays * 24 * 60 * 60 * 1000;
    let cleaned = 0;
    let freed = 0;

    const walk = async (dir) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else {
          const stat = await fs.stat(fullPath);
          if (stat.mtimeMs < cutoff) {
            freed += stat.size;
            await fs.unlink(fullPath);
            cleaned++;
          }
        }
      }
    };

    await walk(dataDir);
    return { cleaned, freed };
  }
}

export default PhotoClassifier;
