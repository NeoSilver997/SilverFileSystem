import { test, describe } from 'node:test';
import assert from 'node:assert';
import { formatBytes, formatDate, truncatePath, getFileStats } from '../lib/utils.js';

describe('Utils Module', () => {
  
  describe('formatBytes', () => {
    test('should format 0 bytes correctly', () => {
      assert.strictEqual(formatBytes(0), '0 Bytes');
    });

    test('should format bytes correctly', () => {
      assert.strictEqual(formatBytes(500), '500 Bytes');
    });

    test('should format kilobytes correctly', () => {
      assert.strictEqual(formatBytes(1024), '1 KB');
      assert.strictEqual(formatBytes(2048), '2 KB');
    });

    test('should format megabytes correctly', () => {
      assert.strictEqual(formatBytes(1048576), '1 MB');
      assert.strictEqual(formatBytes(10485760), '10 MB');
    });

    test('should format gigabytes correctly', () => {
      assert.strictEqual(formatBytes(1073741824), '1 GB');
    });

    test('should format terabytes correctly', () => {
      assert.strictEqual(formatBytes(1099511627776), '1 TB');
    });

    test('should respect decimal places parameter', () => {
      assert.strictEqual(formatBytes(1536, 0), '2 KB');
      assert.strictEqual(formatBytes(1536, 1), '1.5 KB');
      assert.strictEqual(formatBytes(1536, 2), '1.5 KB');
    });

    test('should handle large numbers', () => {
      const result = formatBytes(1125899906842624);
      assert.ok(result.includes('PB'));
    });
  });

  describe('formatDate', () => {
    test('should format date object correctly', () => {
      const date = new Date('2024-01-01T12:00:00Z');
      const result = formatDate(date);
      assert.ok(result.includes('2024') || result.includes('24'));
    });

    test('should format date string correctly', () => {
      const dateStr = '2024-01-01T12:00:00Z';
      const result = formatDate(dateStr);
      assert.ok(typeof result === 'string');
      assert.ok(result.length > 0);
    });

    test('should handle timestamp correctly', () => {
      const timestamp = 1704110400000; // 2024-01-01 12:00:00 UTC
      const result = formatDate(timestamp);
      assert.ok(typeof result === 'string');
      assert.ok(result.length > 0);
    });
  });

  describe('truncatePath', () => {
    test('should not truncate short paths', () => {
      const shortPath = '/home/user/file.txt';
      assert.strictEqual(truncatePath(shortPath, 80), shortPath);
    });

    test('should truncate long paths with default maxLength', () => {
      const longPath = '/home/user/very/long/path/with/many/directories/and/subdirectories/and/more/levels/file.txt';
      const result = truncatePath(longPath);
      assert.ok(result.includes('...'));
      assert.ok(result.length <= 80);
    });

    test('should truncate with custom maxLength', () => {
      const path = '/home/user/documents/projects/file.txt';
      const result = truncatePath(path, 20);
      assert.ok(result.includes('...'));
      assert.ok(result.length <= 20);
    });

    test('should preserve start and end of path', () => {
      const path = '/home/user/documents/projects/myfile.txt';
      const result = truncatePath(path, 30);
      assert.ok(result.startsWith('/home'));
      assert.ok(result.endsWith('.txt'));
    });

    test('should handle paths equal to maxLength', () => {
      const path = '/home/user/file.txt';
      const result = truncatePath(path, path.length);
      assert.strictEqual(result, path);
    });
  });

  describe('getFileStats', () => {
    test('should calculate stats for empty array', () => {
      const stats = getFileStats([]);
      assert.strictEqual(stats.count, 0);
      assert.strictEqual(stats.totalSize, 0);
      assert.strictEqual(stats.avgSize, 0);
      assert.strictEqual(stats.minSize, 0);
      assert.strictEqual(stats.maxSize, 0);
    });

    test('should calculate stats for single file', () => {
      const files = [{ size: 1024 }];
      const stats = getFileStats(files);
      assert.strictEqual(stats.count, 1);
      assert.strictEqual(stats.totalSize, 1024);
      assert.strictEqual(stats.avgSize, 1024);
      assert.strictEqual(stats.minSize, 1024);
      assert.strictEqual(stats.maxSize, 1024);
    });

    test('should calculate stats for multiple files', () => {
      const files = [
        { size: 100 },
        { size: 200 },
        { size: 300 }
      ];
      const stats = getFileStats(files);
      assert.strictEqual(stats.count, 3);
      assert.strictEqual(stats.totalSize, 600);
      assert.strictEqual(stats.avgSize, 200);
      assert.strictEqual(stats.minSize, 100);
      assert.strictEqual(stats.maxSize, 300);
    });

    test('should handle files with varying sizes', () => {
      const files = [
        { size: 1 },
        { size: 1000000 },
        { size: 500 }
      ];
      const stats = getFileStats(files);
      assert.strictEqual(stats.count, 3);
      assert.strictEqual(stats.totalSize, 1000501);
      assert.strictEqual(stats.minSize, 1);
      assert.strictEqual(stats.maxSize, 1000000);
    });

    test('should handle zero-sized files', () => {
      const files = [
        { size: 0 },
        { size: 100 },
        { size: 0 }
      ];
      const stats = getFileStats(files);
      assert.strictEqual(stats.count, 3);
      assert.strictEqual(stats.totalSize, 100);
      assert.strictEqual(stats.minSize, 0);
      assert.strictEqual(stats.maxSize, 100);
    });
  });
});
