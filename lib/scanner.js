import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import { createHash } from 'crypto';

/**
 * File Scanner - Core module for scanning and analyzing files
 */
export class FileScanner {
  constructor(options = {}) {
    this.options = {
      followSymlinks: options.followSymlinks || false,
      maxDepth: options.maxDepth || Infinity,
      excludePatterns: options.excludePatterns || [],
      ...options
    };
  }

  /**
   * Scan directory iteratively to avoid stack overflow with deep directories
   */
  async scanDirectory(dirPath, progressCallback = null) {
    const files = [];
    const directoriesToScan = [{ path: dirPath, depth: 0 }];
    let processedFiles = 0;
    let processedDirs = 0;

    while (directoriesToScan.length > 0) {
      const { path: currentPath, depth } = directoriesToScan.pop();
      
      if (depth > this.options.maxDepth) {
        continue;
      }

      try {
        const entries = await fs.readdir(currentPath, { withFileTypes: true });
        processedDirs++;

        // Report progress every 100 directories
        if (progressCallback && processedDirs % 100 === 0) {
          progressCallback({
            type: 'progress',
            processedDirs,
            processedFiles,
            currentDir: currentPath,
            queueSize: directoriesToScan.length
          });
        }

        for (const entry of entries) {
          const fullPath = path.join(currentPath, entry.name);
          
          // Check exclusion patterns
          if (this.shouldExclude(fullPath)) {
            continue;
          }

          try {
            let stat;
            if (entry.isSymbolicLink() && !this.options.followSymlinks) {
              continue;
            }
            
            stat = await fs.stat(fullPath);

            if (stat.isDirectory()) {
              directoriesToScan.push({ path: fullPath, depth: depth + 1 });
            } else if (stat.isFile()) {
              files.push({
                path: fullPath,
                name: entry.name,
                size: stat.size,
                mtime: stat.mtime,
                atime: stat.atime,
                ctime: stat.ctime
              });
              processedFiles++;

              // Report progress every 1000 files
              if (progressCallback && processedFiles % 1000 === 0) {
                progressCallback({
                  type: 'progress',
                  processedDirs,
                  processedFiles,
                  currentDir: currentPath,
                  queueSize: directoriesToScan.length
                });
              }
            }
          } catch (err) {
            // Skip files that can't be accessed
            if (err.code !== 'EACCES' && err.code !== 'EPERM') {
              if (progressCallback) {
                progressCallback({
                  type: 'warning',
                  message: `Could not access ${fullPath}: ${err.message}`
                });
              } else {
                console.warn(`Warning: Could not access ${fullPath}: ${err.message}`);
              }
            }
          }
        }
      } catch (err) {
        const message = `Could not read directory ${currentPath}: ${err.message}`;
        if (progressCallback) {
          progressCallback({
            type: 'warning',
            message
          });
        } else {
          console.warn(`Warning: ${message}`);
        }
      }
    }

    if (progressCallback) {
      progressCallback({
        type: 'complete',
        processedDirs,
        processedFiles,
        totalFiles: files.length
      });
    }

    return files;
  }

  /**
   * Check if a path should be excluded
   */
  shouldExclude(filePath) {
    return this.options.excludePatterns.some(pattern => {
      if (typeof pattern === 'string') {
        return filePath.includes(pattern);
      }
      return pattern.test(filePath);
    });
  }

  /**
   * Calculate file hash (for duplicate detection) - streaming version for large files
   */
  async calculateHash(filePath, algorithm = 'sha256') {
    try {
      const stat = await fs.stat(filePath);
      
      // For files larger than 2GB, use streaming approach
      if (stat.size > 2 * 1024 * 1024 * 1024) {
        return await this.calculateStreamingHash(filePath, algorithm);
      }
      
      // For smaller files, use the faster readFile approach
      const fileBuffer = await fs.readFile(filePath);
      const hash = createHash(algorithm);
      hash.update(fileBuffer);
      return hash.digest('hex');
    } catch (err) {
      throw new Error(`Failed to calculate hash for ${filePath}: ${err.message}`);
    }
  }

  /**
   * Calculate hash using streaming for very large files
   */
  async calculateStreamingHash(filePath, algorithm = 'sha256') {
    return new Promise((resolve, reject) => {
      const hash = createHash(algorithm);
      const stream = createReadStream(filePath);
      
      stream.on('data', chunk => {
        hash.update(chunk);
      });
      
      stream.on('end', () => {
        resolve(hash.digest('hex'));
      });
      
      stream.on('error', err => {
        reject(new Error(`Failed to calculate streaming hash for ${filePath}: ${err.message}`));
      });
    });
  }

  /**
   * Calculate smart hash - uses different strategies based on file size
   */
  async calculateSmartHash(filePath, algorithm = 'sha256') {
    try {
      const stat = await fs.stat(filePath);
      
      // For very small files (<= 1MB), use full hash
      if (stat.size <= 1024 * 1024) {
        return await this.calculateHash(filePath, algorithm);
      }
      
      // For medium files (1MB < size <= 100MB), use sampling hash
      if (stat.size <= 100 * 1024 * 1024) {
        return await this.calculateSamplingHash(filePath, algorithm);
      }
      
      // For large files (> 100MB), use quick hash
      return await this.calculateQuickHash(filePath);
    } catch (err) {
      throw new Error(`Failed to calculate smart hash for ${filePath}: ${err.message}`);
    }
  }

  /**
   * Calculate hash using sampling method - reads multiple chunks throughout the file
   */
  async calculateSamplingHash(filePath, algorithm = 'sha256', sampleCount = 10) {
    try {
      const stat = await fs.stat(filePath);
      const fileHandle = await fs.open(filePath, 'r');
      
      try {
        const hash = createHash(algorithm);
        const chunkSize = 8192;
        const buffer = Buffer.alloc(chunkSize);
        
        // Add file size to hash for uniqueness
        hash.update(Buffer.from(stat.size.toString()));
        
        // Calculate positions to sample
        const positions = [];
        for (let i = 0; i < sampleCount; i++) {
          const position = Math.floor((stat.size / sampleCount) * i);
          positions.push(Math.min(position, stat.size - chunkSize));
        }
        
        // Read and hash each sample
        for (const position of positions) {
          if (position >= 0) {
            await fileHandle.read(buffer, 0, chunkSize, position);
            hash.update(buffer);
          }
        }
        
        return hash.digest('hex');
      } finally {
        await fileHandle.close();
      }
    } catch (err) {
      throw new Error(`Failed to calculate sampling hash for ${filePath}: ${err.message}`);
    }
  }

  /**
   * Calculate quick hash (first and last chunks only) for faster comparison
   */
  async calculateQuickHash(filePath, chunkSize = 8192) {
    try {
      const stat = await fs.stat(filePath);
      const fileHandle = await fs.open(filePath, 'r');
      
      try {
        const hash = createHash('sha256');
        const buffer = Buffer.alloc(chunkSize);

        // Read first chunk
        await fileHandle.read(buffer, 0, chunkSize, 0);
        hash.update(buffer);

        // Read last chunk if file is large enough
        if (stat.size > chunkSize) {
          await fileHandle.read(buffer, 0, chunkSize, Math.max(0, stat.size - chunkSize));
          hash.update(buffer);
        }

        return hash.digest('hex');
      } finally {
        await fileHandle.close();
      }
    } catch (err) {
      throw new Error(`Failed to calculate quick hash for ${filePath}: ${err.message}`);
    }
  }
}
