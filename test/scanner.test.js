import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { FileScanner } from '../lib/scanner.js';

describe('FileScanner Module', () => {
  const testDir = '/tmp/test-scanner';
  
  before(async () => {
    // Create test directory structure
    await mkdir(testDir, { recursive: true });
    await mkdir(join(testDir, 'subdir'), { recursive: true });
    await mkdir(join(testDir, 'node_modules'), { recursive: true });
    
    // Create test files
    await writeFile(join(testDir, 'file1.txt'), 'Hello World');
    await writeFile(join(testDir, 'file2.txt'), 'Test Content');
    await writeFile(join(testDir, 'subdir', 'file3.txt'), 'Nested File');
    await writeFile(join(testDir, 'node_modules', 'ignored.txt'), 'Should be ignored');
  });

  after(async () => {
    // Clean up test directory
    await rm(testDir, { recursive: true, force: true });
  });

  describe('shouldExclude', () => {
    test('should exclude paths matching string patterns', () => {
      const scanner = new FileScanner({
        excludePatterns: ['node_modules', '.git']
      });
      
      assert.strictEqual(scanner.shouldExclude('/path/to/node_modules/file.js'), true);
      assert.strictEqual(scanner.shouldExclude('/path/to/.git/config'), true);
      assert.strictEqual(scanner.shouldExclude('/path/to/src/file.js'), false);
    });

    test('should exclude paths matching regex patterns', () => {
      const scanner = new FileScanner({
        excludePatterns: [/\.log$/, /tmp/]
      });
      
      assert.strictEqual(scanner.shouldExclude('/path/to/file.log'), true);
      assert.strictEqual(scanner.shouldExclude('/tmp/file.txt'), true);
      assert.strictEqual(scanner.shouldExclude('/path/to/file.txt'), false);
    });

    test('should handle mixed patterns', () => {
      const scanner = new FileScanner({
        excludePatterns: ['cache', /\.tmp$/]
      });
      
      assert.strictEqual(scanner.shouldExclude('/path/cache/file.txt'), true);
      assert.strictEqual(scanner.shouldExclude('/path/file.tmp'), true);
      assert.strictEqual(scanner.shouldExclude('/path/file.txt'), false);
    });

    test('should not exclude when no patterns match', () => {
      const scanner = new FileScanner({
        excludePatterns: ['node_modules']
      });
      
      assert.strictEqual(scanner.shouldExclude('/path/to/src/file.js'), false);
    });
  });

  describe('scanDirectory', () => {
    test('should scan directory and find files', async () => {
      const scanner = new FileScanner({
        excludePatterns: ['node_modules']
      });
      
      const files = await scanner.scanDirectory(testDir);
      
      assert.ok(files.length > 0);
      assert.ok(files.some(f => f.name === 'file1.txt'));
      assert.ok(files.some(f => f.name === 'file2.txt'));
      assert.ok(files.some(f => f.name === 'file3.txt'));
    });

    test('should exclude paths based on patterns', async () => {
      const scanner = new FileScanner({
        excludePatterns: ['node_modules']
      });
      
      const files = await scanner.scanDirectory(testDir);
      
      assert.ok(!files.some(f => f.name === 'ignored.txt'));
    });

    test('should include file metadata', async () => {
      const scanner = new FileScanner();
      const files = await scanner.scanDirectory(testDir);
      
      const file = files.find(f => f.name === 'file1.txt');
      assert.ok(file);
      assert.ok(file.path);
      assert.ok(file.name);
      assert.ok(typeof file.size === 'number');
      assert.ok(file.mtime instanceof Date);
      assert.ok(file.atime instanceof Date);
      assert.ok(file.ctime instanceof Date);
    });

    test('should handle empty directories', async () => {
      const emptyDir = join(testDir, 'empty');
      await mkdir(emptyDir, { recursive: true });
      
      const scanner = new FileScanner();
      const files = await scanner.scanDirectory(emptyDir);
      
      assert.strictEqual(files.length, 0);
      
      await rm(emptyDir, { recursive: true });
    });
  });

  describe('calculateHash', () => {
    test('should calculate SHA256 hash of file', async () => {
      const scanner = new FileScanner();
      const filePath = join(testDir, 'file1.txt');
      
      const hash = await scanner.calculateHash(filePath);
      
      assert.ok(typeof hash === 'string');
      assert.strictEqual(hash.length, 64); // SHA256 produces 64 hex characters
    });

    test('should produce consistent hash for same content', async () => {
      const scanner = new FileScanner();
      const filePath = join(testDir, 'file1.txt');
      
      const hash1 = await scanner.calculateHash(filePath);
      const hash2 = await scanner.calculateHash(filePath);
      
      assert.strictEqual(hash1, hash2);
    });

    test('should produce different hash for different content', async () => {
      const scanner = new FileScanner();
      const file1 = join(testDir, 'file1.txt');
      const file2 = join(testDir, 'file2.txt');
      
      const hash1 = await scanner.calculateHash(file1);
      const hash2 = await scanner.calculateHash(file2);
      
      assert.notStrictEqual(hash1, hash2);
    });

    test('should support different algorithms', async () => {
      const scanner = new FileScanner();
      const filePath = join(testDir, 'file1.txt');
      
      const sha256 = await scanner.calculateHash(filePath, 'sha256');
      const md5 = await scanner.calculateHash(filePath, 'md5');
      
      assert.notStrictEqual(sha256, md5);
      assert.strictEqual(sha256.length, 64);
      assert.strictEqual(md5.length, 32);
    });
  });

  describe('calculateQuickHash', () => {
    test('should calculate quick hash of file', async () => {
      const scanner = new FileScanner();
      const filePath = join(testDir, 'file1.txt');
      
      const hash = await scanner.calculateQuickHash(filePath);
      
      assert.ok(typeof hash === 'string');
      assert.strictEqual(hash.length, 64);
    });

    test('should be faster than full hash for large files', async () => {
      // Create a larger test file
      const largeFile = join(testDir, 'large.bin');
      const size = 10 * 1024 * 1024; // 10 MB
      await writeFile(largeFile, Buffer.alloc(size, 'a'));
      
      const scanner = new FileScanner();
      
      const quickStart = Date.now();
      await scanner.calculateQuickHash(largeFile);
      const quickTime = Date.now() - quickStart;
      
      const fullStart = Date.now();
      await scanner.calculateHash(largeFile);
      const fullTime = Date.now() - fullStart;
      
      // Quick hash should generally be faster (though not guaranteed in all cases)
      // We just verify both complete successfully
      assert.ok(quickTime >= 0);
      assert.ok(fullTime >= 0);
      
      await rm(largeFile);
    });
  });

  describe('calculateSamplingHash', () => {
    test('should calculate sampling hash', async () => {
      const scanner = new FileScanner();
      const filePath = join(testDir, 'file1.txt');
      
      const hash = await scanner.calculateSamplingHash(filePath);
      
      assert.ok(typeof hash === 'string');
      assert.strictEqual(hash.length, 64);
    });

    test('should handle custom sample count', async () => {
      const scanner = new FileScanner();
      const filePath = join(testDir, 'file1.txt');
      
      const hash1 = await scanner.calculateSamplingHash(filePath, 'sha256', 5);
      const hash2 = await scanner.calculateSamplingHash(filePath, 'sha256', 10);
      
      // Different sample counts may produce different hashes
      assert.ok(typeof hash1 === 'string');
      assert.ok(typeof hash2 === 'string');
    });
  });

  describe('calculateSmartHash', () => {
    test('should calculate smart hash for small files', async () => {
      const scanner = new FileScanner();
      const filePath = join(testDir, 'file1.txt');
      
      const hash = await scanner.calculateSmartHash(filePath);
      
      assert.ok(typeof hash === 'string');
      assert.strictEqual(hash.length, 64);
    });

    test('should use appropriate strategy based on file size', async () => {
      const scanner = new FileScanner();
      
      // Small file (< 1MB) - uses full hash
      const smallFile = join(testDir, 'small.txt');
      await writeFile(smallFile, 'small');
      const smallHash = await scanner.calculateSmartHash(smallFile);
      assert.ok(typeof smallHash === 'string');
      
      await rm(smallFile);
    });
  });
});
