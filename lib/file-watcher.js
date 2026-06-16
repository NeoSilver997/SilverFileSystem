import chokidar from 'chokidar';
import path from 'path';
import { PhotoClassifier } from './photo-classifier.js';
import { exiftool } from 'exiftool-vendored';

const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'bmp', 'tiff', 'webp', 'heic', 'heif'
]);

export class FileWatcher {
  constructor(config = {}) {
    this.watchDir = config.watchDir;
    this.classifier = new PhotoClassifier({
      ...config,
      watchDir: config.watchDir
    });
    this.db = config.db || null;
    this.debounceMs = config.debounceMs || 1000;
    this.pendingFiles = new Map();
    this.debounceTimers = new Map();
    this.watcher = null;
    this.running = false;
    this.onFileClassified = config.onFileClassified || null;
    this.onWatcherError = config.onWatcherError || null;
    this.stats = {
      watched: 0,
      classified: 0,
      failed: 0,
      skipped: 0
    };
  }

  async start() {
    if (this.running) {
      console.log('[FileWatcher] Already running');
      return;
    }

    if (!this.watchDir) {
      throw new Error('watchDir is required');
    }

    console.log(`[FileWatcher] Starting watcher on: ${this.watchDir}`);
    this.running = true;

    this.watcher = chokidar.watch(this.watchDir, {
      ignored: /(^|[\/\\])\.|node_modules|photo_library/,
      persistent: true,
      ignoreInitial: false,
      depth: 10,
      awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: 100
      }
    });

    this.watcher
      .on('add', (filePath) => this.handleFile(filePath))
      .on('change', (filePath) => this.handleFile(filePath))
      .on('error', (error) => {
        console.error('[FileWatcher] Error:', error.message);
        if (this.onWatcherError) this.onWatcherError(error);
      })
      .on('ready', () => {
        console.log('[FileWatcher] Initial scan complete, watching for changes...');
      });

    return this;
  }

  async stop() {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    this.running = false;
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.pendingFiles.clear();
    console.log('[FileWatcher] Stopped');
  }

  handleFile(filePath) {
    const ext = path.extname(filePath).toLowerCase().slice(1);
    if (!IMAGE_EXTENSIONS.has(ext)) {
      return;
    }

    if (this.debounceTimers.has(filePath)) {
      clearTimeout(this.debounceTimers.get(filePath));
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      this.processFile(filePath);
    }, this.debounceMs);

    this.debounceTimers.set(filePath, timer);
  }

  async processFile(filePath) {
    this.stats.watched++;
    console.log(`[FileWatcher] Processing: ${path.basename(filePath)}`);

    try {
      let exifData = {};
      try {
        const exif = await exiftool.read(filePath);
        exifData = {
          datetime: {
            taken: exif.DateTimeOriginal || exif.CreateDate
          },
          location: {
            latitude: exif.GPSLatitude,
            longitude: exif.GPSLongitude
          },
          camera: {
            make: exif.Make,
            model: exif.Model
          }
        };
      } catch {}

      const result = await this.classifier.classifyAndRoute(filePath, exifData);

      if (result.success) {
        this.stats.classified++;
        console.log(`[FileWatcher] Classified: ${result.filename} → ${result.category} (${result.destinationPath})`);

        if (this.db && result.destinationPath) {
          try {
            const fileId = await this.findOrCreateFileRecord(filePath, result);
            if (fileId) {
              await this.db.storePhotoClassification(fileId, result.vlmResult, {
                ...result,
                model: result.vlmResult?.model || this.classifier.vlm.model,
                rawResponse: result.vlmResult?.rawResponse || ''
              });
            }
          } catch (dbErr) {
            console.error('[FileWatcher] DB write failed:', dbErr.message);
          }
        }

        if (this.onFileClassified) {
          this.onFileClassified(result);
        }
      } else {
        this.stats.failed++;
        console.error(`[FileWatcher] Failed: ${result.filename} - ${result.error}`);
      }
    } catch (err) {
      this.stats.failed++;
      console.error(`[FileWatcher] Error processing ${filePath}:`, err.message);
    }
  }

  async findOrCreateFileRecord(filePath, result) {
    if (!this.db || !this.db.connection) return null;

    try {
      const [existing] = await this.db.connection.execute(
        'SELECT id FROM scanned_files WHERE path = ?',
        [filePath]
      );
      if (existing.length > 0) {
        return existing[0].id;
      }

      const fs = await import('fs/promises');
      const stat = await fs.stat(filePath);
      const ext = path.extname(filePath).slice(1);
      const name = path.basename(filePath);

      const [insertResult] = await this.db.connection.execute(
        `INSERT INTO scanned_files (path, name, size, extension, mtime, created_at)
         VALUES (?, ?, ?, ?, NOW(), NOW())`,
        [filePath, name, stat.size, ext]
      );

      return insertResult.insertId;
    } catch (err) {
      console.error('[FileWatcher] findOrCreateFileRecord failed:', err.message);
      return null;
    }
  }

  getStats() {
    return { ...this.stats };
  }

  async classifyExistingFiles(directory) {
    const fs = await import('fs/promises');
    const files = [];

    const walk = async (dir) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'photo_library') {
            await walk(fullPath);
          }
        } else {
          const ext = path.extname(entry.name).toLowerCase().slice(1);
          if (IMAGE_EXTENSIONS.has(ext)) {
            files.push(fullPath);
          }
        }
      }
    };

    await walk(directory);
    console.log(`[FileWatcher] Found ${files.length} images to classify`);

    return this.classifier.batchClassify(files, {}, (progress) => {
      console.log(`[FileWatcher] Progress: ${progress.current}/${progress.total} - ${progress.filename} → ${progress.category}`);
    });
  }
}

export default FileWatcher;
