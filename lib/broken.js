import fs from 'fs/promises';
import path from 'path';

/**
 * Broken Files Finder
 * Detects files that may be corrupted or have issues
 */
export class BrokenFilesFinder {
  constructor(options = {}) {
    this.options = {
      followSymlinks: options.followSymlinks || false,
      excludePatterns: options.excludePatterns || [],
      checkExtensions: options.checkExtensions || true,
      ...options
    };
  }

  /**
   * Find broken symbolic links
   */
  async findBrokenSymlinks(dirPath) {
    const brokenLinks = [];
    await this._scanForBrokenSymlinks(dirPath, brokenLinks);
    return brokenLinks;
  }

  async _scanForBrokenSymlinks(dirPath, brokenLinks) {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        
        if (this.shouldExclude(fullPath)) {
          continue;
        }

        try {
          if (entry.isSymbolicLink()) {
            // Try to access the target - if it fails, the link is broken
            try {
              await fs.stat(fullPath);
            } catch (err) {
              if (err.code === 'ENOENT') {
                const linkTarget = await fs.readlink(fullPath);
                brokenLinks.push({
                  path: fullPath,
                  name: entry.name,
                  target: linkTarget,
                  type: 'broken-symlink'
                });
              }
            }
          } else if (entry.isDirectory() && this.options.followSymlinks) {
            await this._scanForBrokenSymlinks(fullPath, brokenLinks);
          } else {
            const stat = await fs.stat(fullPath);
            if (stat.isDirectory()) {
              await this._scanForBrokenSymlinks(fullPath, brokenLinks);
            }
          }
        } catch (err) {
          if (err.code !== 'EACCES' && err.code !== 'EPERM') {
            console.warn(`Warning: Could not access ${fullPath}: ${err.message}`);
          }
        }
      }
    } catch (err) {
      console.warn(`Warning: Could not read directory ${dirPath}: ${err.message}`);
    }
  }

  /**
   * Find files with invalid names (special characters, etc.)
   */
  async findInvalidNames(dirPath) {
    const invalidFiles = [];
    await this._scanForInvalidNames(dirPath, invalidFiles);
    return invalidFiles;
  }

  async _scanForInvalidNames(dirPath, invalidFiles) {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        
        if (this.shouldExclude(fullPath)) {
          continue;
        }

        try {
          // Check for problematic characters in filename
          const problematicChars = /[<>:"|?*\x00-\x1F]/;
          const hasTrailingSpace = entry.name.endsWith(' ') || entry.name.endsWith('.');
          const isHidden = entry.name.startsWith('.');
          
          if (problematicChars.test(entry.name) || hasTrailingSpace) {
            invalidFiles.push({
              path: fullPath,
              name: entry.name,
              issue: problematicChars.test(entry.name) ? 'invalid-characters' : 'trailing-space',
              type: 'invalid-name'
            });
          }

          const stat = await fs.stat(fullPath);
          if (stat.isDirectory()) {
            await this._scanForInvalidNames(fullPath, invalidFiles);
          }
        } catch (err) {
          if (err.code !== 'EACCES' && err.code !== 'EPERM') {
            console.warn(`Warning: Could not access ${fullPath}: ${err.message}`);
          }
        }
      }
    } catch (err) {
      console.warn(`Warning: Could not read directory ${dirPath}: ${err.message}`);
    }
  }

  /**
   * Find files with mismatched extensions
   */
  async findMismatchedExtensions(dirPath) {
    const mismatchedFiles = [];
    await this._scanForMismatchedExtensions(dirPath, mismatchedFiles);
    return mismatchedFiles;
  }

  async _scanForMismatchedExtensions(dirPath, mismatchedFiles) {
    if (!this.options.checkExtensions) {
      return;
    }

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        
        if (this.shouldExclude(fullPath)) {
          continue;
        }

        try {
          const stat = await fs.stat(fullPath);
          
          if (stat.isDirectory()) {
            await this._scanForMismatchedExtensions(fullPath, mismatchedFiles);
          } else if (stat.isFile()) {
            // Check for double extensions (e.g., .tar.gz counted as single)
            const ext = path.extname(entry.name);
            
            // Files without extension but with content
            if (!ext && stat.size > 0) {
              const fileHandle = await fs.open(fullPath, 'r');
              try {
                const buffer = Buffer.alloc(512);
                await fileHandle.read(buffer, 0, 512, 0);
                
                // Simple magic number detection
                const detectedType = this.detectFileType(buffer);
                if (detectedType && detectedType !== 'unknown') {
                  mismatchedFiles.push({
                    path: fullPath,
                    name: entry.name,
                    expected: detectedType,
                    actual: 'no-extension',
                    type: 'mismatched-extension'
                  });
                }
              } finally {
                await fileHandle.close();
              }
            }
          }
        } catch (err) {
          if (err.code !== 'EACCES' && err.code !== 'EPERM') {
            console.warn(`Warning: Could not access ${fullPath}: ${err.message}`);
          }
        }
      }
    } catch (err) {
      console.warn(`Warning: Could not read directory ${dirPath}: ${err.message}`);
    }
  }

  /**
   * Detect file type from magic numbers
   */
  detectFileType(buffer) {
    // Check common file signatures
    const signatures = {
      'image/jpeg': [0xFF, 0xD8, 0xFF],
      'image/png': [0x89, 0x50, 0x4E, 0x47],
      'image/gif': [0x47, 0x49, 0x46, 0x38],
      'application/pdf': [0x25, 0x50, 0x44, 0x46],
      'application/zip': [0x50, 0x4B, 0x03, 0x04],
      'video/mp4': [0x00, 0x00, 0x00, null, 0x66, 0x74, 0x79, 0x70],
    };

    for (const [type, signature] of Object.entries(signatures)) {
      let matches = true;
      for (let i = 0; i < signature.length; i++) {
        if (signature[i] !== null && buffer[i] !== signature[i]) {
          matches = false;
          break;
        }
      }
      if (matches) {
        return type;
      }
    }

    return 'unknown';
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
}
