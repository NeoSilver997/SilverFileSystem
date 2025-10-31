import { FileScanner } from './scanner.js';

/**
 * Large Files Finder
 */
export class LargeFilesFinder {
  constructor(scanner) {
    this.scanner = scanner || new FileScanner();
  }

  /**
   * Find large files above a certain threshold
   */
  async findLargeFiles(paths, options = {}) {
    const { 
      minSize = 100 * 1024 * 1024, // Default: 100 MB
      limit = 50 
    } = options;
    
    // Collect all files
    const allFiles = [];
    for (const dirPath of paths) {
      const files = await this.scanner.scanDirectory(dirPath);
      allFiles.push(...files);
    }

    // Filter and sort by size
    const largeFiles = allFiles
      .filter(file => file.size >= minSize)
      .sort((a, b) => b.size - a.size)
      .slice(0, limit);

    return largeFiles;
  }

  /**
   * Group large files by extension
   */
  groupByExtension(files) {
    const groups = new Map();
    
    for (const file of files) {
      const ext = this.getExtension(file.name);
      if (!groups.has(ext)) {
        groups.set(ext, []);
      }
      groups.get(ext).push(file);
    }
    
    return groups;
  }

  /**
   * Get file extension
   */
  getExtension(filename) {
    const match = filename.match(/\.([^.]+)$/);
    return match ? match[1].toLowerCase() : 'no extension';
  }

  /**
   * Calculate total size for a list of files
   */
  calculateTotalSize(files) {
    return files.reduce((sum, file) => sum + file.size, 0);
  }
}
