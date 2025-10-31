import fs from 'fs/promises';
import path from 'path';

/**
 * Empty Files and Folders Finder
 */
export class EmptyFinder {
  constructor(options = {}) {
    this.options = {
      followSymlinks: options.followSymlinks || false,
      excludePatterns: options.excludePatterns || [],
      ...options
    };
  }

  /**
   * Find empty files
   */
  async findEmptyFiles(dirPath) {
    const emptyFiles = [];
    await this._scanForEmptyFiles(dirPath, emptyFiles);
    return emptyFiles;
  }

  async _scanForEmptyFiles(dirPath, emptyFiles, depth = 0) {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        
        if (this.shouldExclude(fullPath)) {
          continue;
        }

        try {
          if (entry.isSymbolicLink() && !this.options.followSymlinks) {
            continue;
          }

          const stat = await fs.stat(fullPath);

          if (stat.isDirectory()) {
            await this._scanForEmptyFiles(fullPath, emptyFiles, depth + 1);
          } else if (stat.isFile() && stat.size === 0) {
            emptyFiles.push({
              path: fullPath,
              name: entry.name,
              type: 'file'
            });
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
   * Find empty directories
   */
  async findEmptyDirectories(dirPath) {
    const emptyDirs = [];
    await this._scanForEmptyDirs(dirPath, emptyDirs);
    return emptyDirs;
  }

  async _scanForEmptyDirs(dirPath, emptyDirs) {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const subdirs = [];

      let hasFiles = false;

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        
        if (this.shouldExclude(fullPath)) {
          continue;
        }

        try {
          if (entry.isSymbolicLink() && !this.options.followSymlinks) {
            continue;
          }

          const stat = await fs.stat(fullPath);

          if (stat.isDirectory()) {
            subdirs.push(fullPath);
          } else if (stat.isFile()) {
            hasFiles = true;
          }
        } catch (err) {
          if (err.code !== 'EACCES' && err.code !== 'EPERM') {
            console.warn(`Warning: Could not access ${fullPath}: ${err.message}`);
          }
        }
      }

      // Recursively check subdirectories
      let hasNonEmptySubdirs = false;
      for (const subdir of subdirs) {
        const isEmpty = await this._scanForEmptyDirs(subdir, emptyDirs);
        if (!isEmpty) {
          hasNonEmptySubdirs = true;
        }
      }

      // If directory has no files and no non-empty subdirectories, it's empty
      const isEmpty = !hasFiles && !hasNonEmptySubdirs;
      if (isEmpty && subdirs.length === 0) {
        emptyDirs.push({
          path: dirPath,
          name: path.basename(dirPath),
          type: 'directory'
        });
      }

      return isEmpty;
    } catch (err) {
      console.warn(`Warning: Could not read directory ${dirPath}: ${err.message}`);
      return false;
    }
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
