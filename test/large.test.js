import { test, describe } from 'node:test';
import assert from 'node:assert';
import { LargeFilesFinder } from '../lib/large.js';

describe('LargeFilesFinder Module', () => {
  
  describe('getExtension', () => {
    test('should extract extension from filename', () => {
      const finder = new LargeFilesFinder();
      assert.strictEqual(finder.getExtension('file.txt'), 'txt');
      assert.strictEqual(finder.getExtension('document.pdf'), 'pdf');
      assert.strictEqual(finder.getExtension('image.png'), 'png');
    });

    test('should handle files with multiple dots', () => {
      const finder = new LargeFilesFinder();
      assert.strictEqual(finder.getExtension('archive.tar.gz'), 'gz');
      assert.strictEqual(finder.getExtension('my.file.name.txt'), 'txt');
    });

    test('should handle files without extension', () => {
      const finder = new LargeFilesFinder();
      assert.strictEqual(finder.getExtension('README'), 'no extension');
      assert.strictEqual(finder.getExtension('Makefile'), 'no extension');
    });

    test('should convert extension to lowercase', () => {
      const finder = new LargeFilesFinder();
      assert.strictEqual(finder.getExtension('FILE.TXT'), 'txt');
      assert.strictEqual(finder.getExtension('Document.PDF'), 'pdf');
    });

    test('should handle hidden files', () => {
      const finder = new LargeFilesFinder();
      assert.strictEqual(finder.getExtension('.gitignore'), 'gitignore');
      assert.strictEqual(finder.getExtension('.env'), 'env');
    });

    test('should handle empty string', () => {
      const finder = new LargeFilesFinder();
      assert.strictEqual(finder.getExtension(''), 'no extension');
    });
  });

  describe('calculateTotalSize', () => {
    test('should calculate total size of empty array', () => {
      const finder = new LargeFilesFinder();
      const result = finder.calculateTotalSize([]);
      assert.strictEqual(result, 0);
    });

    test('should calculate total size of single file', () => {
      const finder = new LargeFilesFinder();
      const files = [{ size: 1024 }];
      const result = finder.calculateTotalSize(files);
      assert.strictEqual(result, 1024);
    });

    test('should calculate total size of multiple files', () => {
      const finder = new LargeFilesFinder();
      const files = [
        { size: 100 },
        { size: 200 },
        { size: 300 }
      ];
      const result = finder.calculateTotalSize(files);
      assert.strictEqual(result, 600);
    });

    test('should handle large file sizes', () => {
      const finder = new LargeFilesFinder();
      const files = [
        { size: 1073741824 }, // 1 GB
        { size: 2147483648 }, // 2 GB
      ];
      const result = finder.calculateTotalSize(files);
      assert.strictEqual(result, 3221225472); // 3 GB
    });

    test('should handle zero-sized files', () => {
      const finder = new LargeFilesFinder();
      const files = [
        { size: 0 },
        { size: 100 },
        { size: 0 }
      ];
      const result = finder.calculateTotalSize(files);
      assert.strictEqual(result, 100);
    });
  });

  describe('groupByExtension', () => {
    test('should group files by extension', () => {
      const finder = new LargeFilesFinder();
      const files = [
        { name: 'file1.txt', size: 100 },
        { name: 'file2.txt', size: 200 },
        { name: 'image.png', size: 300 }
      ];
      
      const groups = finder.groupByExtension(files);
      
      assert.ok(groups instanceof Map);
      assert.strictEqual(groups.size, 2);
      assert.strictEqual(groups.get('txt').length, 2);
      assert.strictEqual(groups.get('png').length, 1);
    });

    test('should handle files without extension', () => {
      const finder = new LargeFilesFinder();
      const files = [
        { name: 'README', size: 100 },
        { name: 'Makefile', size: 200 }
      ];
      
      const groups = finder.groupByExtension(files);
      
      assert.strictEqual(groups.size, 1);
      assert.ok(groups.has('no extension'));
      assert.strictEqual(groups.get('no extension').length, 2);
    });

    test('should handle mixed extensions', () => {
      const finder = new LargeFilesFinder();
      const files = [
        { name: 'file.txt', size: 100 },
        { name: 'image.PNG', size: 200 },
        { name: 'doc.pdf', size: 300 },
        { name: 'photo.png', size: 400 }
      ];
      
      const groups = finder.groupByExtension(files);
      
      assert.strictEqual(groups.size, 3);
      assert.strictEqual(groups.get('txt').length, 1);
      assert.strictEqual(groups.get('png').length, 2); // Should be lowercase
      assert.strictEqual(groups.get('pdf').length, 1);
    });

    test('should handle empty array', () => {
      const finder = new LargeFilesFinder();
      const groups = finder.groupByExtension([]);
      
      assert.ok(groups instanceof Map);
      assert.strictEqual(groups.size, 0);
    });

    test('should preserve file objects in groups', () => {
      const finder = new LargeFilesFinder();
      const files = [
        { name: 'file1.txt', size: 100, path: '/path/file1.txt' },
        { name: 'file2.txt', size: 200, path: '/path/file2.txt' }
      ];
      
      const groups = finder.groupByExtension(files);
      const txtFiles = groups.get('txt');
      
      assert.strictEqual(txtFiles[0].size, 100);
      assert.strictEqual(txtFiles[0].path, '/path/file1.txt');
      assert.strictEqual(txtFiles[1].size, 200);
      assert.strictEqual(txtFiles[1].path, '/path/file2.txt');
    });
  });

  describe('findLargeFiles', () => {
    test('should find files above size threshold', async () => {
      // Mock scanner
      const mockScanner = {
        scanDirectory: async () => [
          { name: 'small.txt', size: 1000, path: '/small.txt' },
          { name: 'large1.bin', size: 200 * 1024 * 1024, path: '/large1.bin' },
          { name: 'large2.bin', size: 150 * 1024 * 1024, path: '/large2.bin' }
        ]
      };
      
      const finder = new LargeFilesFinder(mockScanner);
      const result = await finder.findLargeFiles(['/test'], { 
        minSize: 100 * 1024 * 1024,
        limit: 10
      });
      
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].name, 'large1.bin'); // Should be sorted by size descending
      assert.strictEqual(result[1].name, 'large2.bin');
    });

    test('should respect limit parameter', async () => {
      const mockScanner = {
        scanDirectory: async () => [
          { name: 'file1.bin', size: 500 * 1024 * 1024, path: '/file1.bin' },
          { name: 'file2.bin', size: 400 * 1024 * 1024, path: '/file2.bin' },
          { name: 'file3.bin', size: 300 * 1024 * 1024, path: '/file3.bin' },
          { name: 'file4.bin', size: 200 * 1024 * 1024, path: '/file4.bin' }
        ]
      };
      
      const finder = new LargeFilesFinder(mockScanner);
      const result = await finder.findLargeFiles(['/test'], { 
        minSize: 100 * 1024 * 1024,
        limit: 2
      });
      
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].name, 'file1.bin'); // Largest
      assert.strictEqual(result[1].name, 'file2.bin'); // Second largest
    });

    test('should use default options when not provided', async () => {
      const mockScanner = {
        scanDirectory: async () => [
          { name: 'small.txt', size: 1000, path: '/small.txt' },
          { name: 'large.bin', size: 200 * 1024 * 1024, path: '/large.bin' }
        ]
      };
      
      const finder = new LargeFilesFinder(mockScanner);
      const result = await finder.findLargeFiles(['/test']);
      
      // Default minSize is 100 MB, so large.bin should be included
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, 'large.bin');
    });

    test('should handle empty results', async () => {
      const mockScanner = {
        scanDirectory: async () => [
          { name: 'small1.txt', size: 1000, path: '/small1.txt' },
          { name: 'small2.txt', size: 2000, path: '/small2.txt' }
        ]
      };
      
      const finder = new LargeFilesFinder(mockScanner);
      const result = await finder.findLargeFiles(['/test'], { 
        minSize: 100 * 1024 * 1024
      });
      
      assert.strictEqual(result.length, 0);
    });

    test('should scan multiple paths', async () => {
      let scanCount = 0;
      const mockScanner = {
        scanDirectory: async () => {
          scanCount++;
          return [
            { name: `large${scanCount}.bin`, size: 200 * 1024 * 1024, path: `/large${scanCount}.bin` }
          ];
        }
      };
      
      const finder = new LargeFilesFinder(mockScanner);
      const result = await finder.findLargeFiles(['/path1', '/path2'], { 
        minSize: 100 * 1024 * 1024
      });
      
      assert.strictEqual(result.length, 2);
      assert.strictEqual(scanCount, 2);
    });
  });
});
