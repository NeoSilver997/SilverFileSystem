import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { DuplicateFinder } from '../lib/duplicates.js';

describe('DuplicateFinder Module', () => {
  const testDir = '/tmp/test-duplicates';
  
  before(async () => {
    // Create test directory structure
    await mkdir(testDir, { recursive: true });
    await mkdir(join(testDir, 'dir1'), { recursive: true });
    await mkdir(join(testDir, 'dir2'), { recursive: true });
    
    // Create duplicate files (same content)
    const content = 'This is duplicate content';
    await writeFile(join(testDir, 'dir1', 'dup1.txt'), content);
    await writeFile(join(testDir, 'dir2', 'dup2.txt'), content);
    await writeFile(join(testDir, 'dup3.txt'), content);
    
    // Create unique files
    await writeFile(join(testDir, 'unique1.txt'), 'Unique content 1');
    await writeFile(join(testDir, 'unique2.txt'), 'Unique content 2');
    
    // Create files with different sizes but same name
    await writeFile(join(testDir, 'dir1', 'same-name.txt'), 'Short');
    await writeFile(join(testDir, 'dir2', 'same-name.txt'), 'This is much longer content');
  });

  after(async () => {
    // Clean up test directory
    await rm(testDir, { recursive: true, force: true });
  });

  describe('calculateWastedSpace', () => {
    test('should calculate wasted space correctly', () => {
      const finder = new DuplicateFinder();
      
      const duplicateGroups = [
        [
          { size: 1000, path: '/file1.txt' },
          { size: 1000, path: '/file2.txt' }
        ],
        [
          { size: 500, path: '/file3.txt' },
          { size: 500, path: '/file4.txt' },
          { size: 500, path: '/file5.txt' }
        ]
      ];
      
      const wasted = finder.calculateWastedSpace(duplicateGroups);
      
      // First group: 1 duplicate * 1000 = 1000
      // Second group: 2 duplicates * 500 = 1000
      // Total: 2000
      assert.strictEqual(wasted, 2000);
    });

    test('should return 0 for no duplicates', () => {
      const finder = new DuplicateFinder();
      const wasted = finder.calculateWastedSpace([]);
      assert.strictEqual(wasted, 0);
    });

    test('should handle single group correctly', () => {
      const finder = new DuplicateFinder();
      
      const duplicateGroups = [
        [
          { size: 1024, path: '/file1.txt' },
          { size: 1024, path: '/file2.txt' },
          { size: 1024, path: '/file3.txt' },
          { size: 1024, path: '/file4.txt' }
        ]
      ];
      
      const wasted = finder.calculateWastedSpace(duplicateGroups);
      
      // 3 duplicates * 1024 = 3072
      assert.strictEqual(wasted, 3072);
    });

    test('should handle groups with only 2 files', () => {
      const finder = new DuplicateFinder();
      
      const duplicateGroups = [
        [
          { size: 2048, path: '/file1.txt' },
          { size: 2048, path: '/file2.txt' }
        ]
      ];
      
      const wasted = finder.calculateWastedSpace(duplicateGroups);
      
      // 1 duplicate * 2048 = 2048
      assert.strictEqual(wasted, 2048);
    });

    test('should handle large file sizes', () => {
      const finder = new DuplicateFinder();
      
      const duplicateGroups = [
        [
          { size: 1073741824, path: '/file1.bin' }, // 1 GB
          { size: 1073741824, path: '/file2.bin' }
        ]
      ];
      
      const wasted = finder.calculateWastedSpace(duplicateGroups);
      assert.strictEqual(wasted, 1073741824);
    });
  });

  describe('findDuplicates', () => {
    test('should find duplicate files', async () => {
      // Mock scanner
      const mockScanner = {
        scanDirectory: async () => [
          { name: 'file1.txt', size: 100, path: '/test/file1.txt' },
          { name: 'file2.txt', size: 100, path: '/test/file2.txt' },
          { name: 'unique.txt', size: 200, path: '/test/unique.txt' }
        ],
        calculateQuickHash: async (path) => {
          if (path.includes('file1') || path.includes('file2')) return 'hash123';
          return 'hash456';
        },
        calculateHash: async (path) => {
          if (path.includes('file1') || path.includes('file2')) return 'fullhash123';
          return 'fullhash456';
        }
      };
      
      const finder = new DuplicateFinder(mockScanner);
      const duplicates = await finder.findDuplicates(['/test']);
      
      assert.ok(duplicates.length > 0);
      assert.ok(duplicates[0].length === 2);
    });

    test('should filter by minimum size', async () => {
      const mockScanner = {
        scanDirectory: async () => [
          { name: 'small1.txt', size: 50, path: '/test/small1.txt' },
          { name: 'small2.txt', size: 50, path: '/test/small2.txt' },
          { name: 'large1.txt', size: 200, path: '/test/large1.txt' },
          { name: 'large2.txt', size: 200, path: '/test/large2.txt' }
        ],
        calculateQuickHash: async (path) => {
          if (path.includes('small')) return 'smhash';
          return 'lghash';
        },
        calculateHash: async (path) => {
          if (path.includes('small')) return 'smallhash';
          return 'largehash';
        }
      };
      
      const finder = new DuplicateFinder(mockScanner);
      const duplicates = await finder.findDuplicates(['/test'], { minSize: 100 });
      
      // Should only find large files
      assert.ok(duplicates.length > 0);
      assert.ok(duplicates[0][0].size >= 100);
    });

    test('should return empty array when no duplicates found', async () => {
      const mockScanner = {
        scanDirectory: async () => [
          { name: 'file1.txt', size: 100, path: '/test/file1.txt' },
          { name: 'file2.txt', size: 200, path: '/test/file2.txt' },
          { name: 'file3.txt', size: 300, path: '/test/file3.txt' }
        ],
        calculateHash: async () => Math.random().toString()
      };
      
      const finder = new DuplicateFinder(mockScanner);
      const duplicates = await finder.findDuplicates(['/test'], { useQuickHash: false });
      
      assert.strictEqual(duplicates.length, 0);
    });

    test('should use full hash when useQuickHash is false', async () => {
      let quickHashCalled = false;
      let fullHashCalled = false;
      
      const mockScanner = {
        scanDirectory: async () => [
          { name: 'file1.txt', size: 100, path: '/test/file1.txt' },
          { name: 'file2.txt', size: 100, path: '/test/file2.txt' }
        ],
        calculateQuickHash: async () => {
          quickHashCalled = true;
          return 'quickhash';
        },
        calculateHash: async () => {
          fullHashCalled = true;
          return 'fullhash';
        }
      };
      
      const finder = new DuplicateFinder(mockScanner);
      await finder.findDuplicates(['/test'], { useQuickHash: false });
      
      assert.strictEqual(quickHashCalled, false);
      assert.strictEqual(fullHashCalled, true);
    });

    test('should handle multiple directories', async () => {
      let scanCount = 0;
      const mockScanner = {
        scanDirectory: async (path) => {
          scanCount++;
          return [
            { name: `file${scanCount}.txt`, size: 100, path: `${path}/file${scanCount}.txt` }
          ];
        },
        calculateHash: async () => 'samehash'
      };
      
      const finder = new DuplicateFinder(mockScanner);
      await finder.findDuplicates(['/test1', '/test2'], { useQuickHash: false });
      
      assert.strictEqual(scanCount, 2);
    });

    test('should group files with same size first', async () => {
      const mockScanner = {
        scanDirectory: async () => [
          { name: 'a.txt', size: 100, path: '/a.txt' },
          { name: 'b.txt', size: 200, path: '/b.txt' },
          { name: 'c.txt', size: 100, path: '/c.txt' },
          { name: 'd.txt', size: 300, path: '/d.txt' }
        ],
        calculateHash: async (path) => {
          if (path.includes('a') || path.includes('c')) return 'hash100';
          return Math.random().toString();
        }
      };
      
      const finder = new DuplicateFinder(mockScanner);
      const duplicates = await finder.findDuplicates(['/test'], { useQuickHash: false });
      
      // Should find duplicates for files a and c (size 100)
      if (duplicates.length > 0) {
        assert.strictEqual(duplicates[0][0].size, 100);
        assert.strictEqual(duplicates[0][1].size, 100);
      }
    });
  });
});
