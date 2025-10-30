import fs from 'fs/promises';
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
   * Scan directory recursively and collect file information
   */
  async scanDirectory(dirPath, depth = 0) {
    const files = [];
    
    if (depth > this.options.maxDepth) {
      return files;
    }

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        
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
            const subFiles = await this.scanDirectory(fullPath, depth + 1);
            files.push(...subFiles);
          } else if (stat.isFile()) {
            files.push({
              path: fullPath,
              name: entry.name,
              size: stat.size,
              mtime: stat.mtime,
              atime: stat.atime,
              ctime: stat.ctime
            });
          }
        } catch (err) {
          // Skip files that can't be accessed
          if (err.code !== 'EACCES' && err.code !== 'EPERM') {
            console.warn(`Warning: Could not access ${fullPath}: ${err.message}`);
          }
        }
      }
    } catch (err) {
      console.warn(`Warning: Could not read directory ${dirPath}: ${err.message}`);
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
   * Calculate file hash (for duplicate detection)
   */
  async calculateHash(filePath, algorithm = 'sha256') {
    try {
      const fileBuffer = await fs.readFile(filePath);
      const hash = createHash(algorithm);
      hash.update(fileBuffer);
      return hash.digest('hex');
    } catch (err) {
      throw new Error(`Failed to calculate hash for ${filePath}: ${err.message}`);
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
