import { FileScanner } from './scanner.js';

/**
 * Duplicate File Finder
 */
export class DuplicateFinder {
  constructor(scanner) {
    this.scanner = scanner || new FileScanner();
  }

  /**
   * Find duplicate files by comparing sizes and hashes
   */
  async findDuplicates(paths, options = {}) {
    const { minSize = 0, useQuickHash = true } = options;
    
    // Collect all files
    const allFiles = [];
    for (const dirPath of paths) {
      const files = await this.scanner.scanDirectory(dirPath);
      allFiles.push(...files);
    }

    // Filter by minimum size
    const filteredFiles = allFiles.filter(file => file.size >= minSize);

    // Group by size first (quick comparison)
    const sizeGroups = new Map();
    for (const file of filteredFiles) {
      if (!sizeGroups.has(file.size)) {
        sizeGroups.set(file.size, []);
      }
      sizeGroups.get(file.size).push(file);
    }

    // Find potential duplicates (files with same size)
    const potentialDuplicates = Array.from(sizeGroups.values())
      .filter(group => group.length > 1);

    if (potentialDuplicates.length === 0) {
      return [];
    }

    // Calculate hashes for potential duplicates
    const duplicateGroups = [];
    
    for (const group of potentialDuplicates) {
      const hashMap = new Map();
      
      for (const file of group) {
        try {
          // Use quick hash first if enabled
          let hash;
          if (useQuickHash) {
            hash = await this.scanner.calculateQuickHash(file.path);
          } else {
            hash = await this.scanner.calculateHash(file.path);
          }
          
          if (!hashMap.has(hash)) {
            hashMap.set(hash, []);
          }
          hashMap.get(hash).push(file);
        } catch (err) {
          console.warn(`Warning: ${err.message}`);
        }
      }

      // If using quick hash, verify with full hash for potential matches
      if (useQuickHash) {
        for (const [quickHash, files] of hashMap.entries()) {
          if (files.length > 1) {
            const fullHashMap = new Map();
            
            for (const file of files) {
              try {
                const fullHash = await this.scanner.calculateHash(file.path);
                if (!fullHashMap.has(fullHash)) {
                  fullHashMap.set(fullHash, []);
                }
                fullHashMap.get(fullHash).push(file);
              } catch (err) {
                console.warn(`Warning: ${err.message}`);
              }
            }

            // Add verified duplicate groups
            for (const duplicates of fullHashMap.values()) {
              if (duplicates.length > 1) {
                duplicateGroups.push(duplicates);
              }
            }
          }
        }
      } else {
        // Add duplicate groups directly
        for (const duplicates of hashMap.values()) {
          if (duplicates.length > 1) {
            duplicateGroups.push(duplicates);
          }
        }
      }
    }

    return duplicateGroups;
  }

  /**
   * Calculate wasted space from duplicates
   */
  calculateWastedSpace(duplicateGroups) {
    let wastedSpace = 0;
    
    for (const group of duplicateGroups) {
      if (group.length > 1) {
        // Wasted space = (count - 1) * size
        wastedSpace += (group.length - 1) * group[0].size;
      }
    }
    
    return wastedSpace;
  }
}
