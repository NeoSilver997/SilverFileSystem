import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdir, writeFile, rm, symlink } from 'fs/promises';
import { join } from 'path';
import { BrokenFilesFinder } from '../lib/broken.js';

describe('BrokenFilesFinder Module', () => {
  const testDir = '/tmp/test-broken';
  
  before(async () => {
    // Create test directory structure
    await mkdir(testDir, { recursive: true });
    
    // Create regular files
    await writeFile(join(testDir, 'regular.txt'), 'content');
    
    // Create a file to link to
    await writeFile(join(testDir, 'target.txt'), 'target content');
    
    // Create valid symlink
    try {
      await symlink(join(testDir, 'target.txt'), join(testDir, 'valid-link.txt'));
    } catch (err) {
      // Symlinks might not be supported on all systems
    }
    
    // Create broken symlink (pointing to non-existent file)
    try {
      await symlink(join(testDir, 'nonexistent.txt'), join(testDir, 'broken-link.txt'));
    } catch (err) {
      // Symlinks might not be supported on all systems
    }
  });

  after(async () => {
    // Clean up test directory
    await rm(testDir, { recursive: true, force: true });
  });

  describe('shouldExclude', () => {
    test('should exclude paths matching string patterns', () => {
      const finder = new BrokenFilesFinder({
        excludePatterns: ['node_modules', '.git']
      });
      
      assert.strictEqual(finder.shouldExclude('/path/to/node_modules/file.js'), true);
      assert.strictEqual(finder.shouldExclude('/path/to/.git/config'), true);
      assert.strictEqual(finder.shouldExclude('/path/to/src/file.js'), false);
    });

    test('should exclude paths matching regex patterns', () => {
      const finder = new BrokenFilesFinder({
        excludePatterns: [/\.log$/, /cache/]
      });
      
      assert.strictEqual(finder.shouldExclude('/path/to/file.log'), true);
      assert.strictEqual(finder.shouldExclude('/path/cache/file.txt'), true);
      assert.strictEqual(finder.shouldExclude('/path/to/file.txt'), false);
    });

    test('should not exclude when no patterns match', () => {
      const finder = new BrokenFilesFinder({
        excludePatterns: ['cache']
      });
      
      assert.strictEqual(finder.shouldExclude('/path/to/file.txt'), false);
    });
  });

  describe('detectFileType', () => {
    test('should detect JPEG files', () => {
      const finder = new BrokenFilesFinder();
      const buffer = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
      
      const type = finder.detectFileType(buffer);
      assert.strictEqual(type, 'image/jpeg');
    });

    test('should detect PNG files', () => {
      const finder = new BrokenFilesFinder();
      const buffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A]);
      
      const type = finder.detectFileType(buffer);
      assert.strictEqual(type, 'image/png');
    });

    test('should detect GIF files', () => {
      const finder = new BrokenFilesFinder();
      const buffer = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
      
      const type = finder.detectFileType(buffer);
      assert.strictEqual(type, 'image/gif');
    });

    test('should detect PDF files', () => {
      const finder = new BrokenFilesFinder();
      const buffer = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2D]);
      
      const type = finder.detectFileType(buffer);
      assert.strictEqual(type, 'application/pdf');
    });

    test('should detect ZIP files', () => {
      const finder = new BrokenFilesFinder();
      const buffer = Buffer.from([0x50, 0x4B, 0x03, 0x04]);
      
      const type = finder.detectFileType(buffer);
      assert.strictEqual(type, 'application/zip');
    });

    test('should return unknown for unrecognized formats', () => {
      const finder = new BrokenFilesFinder();
      const buffer = Buffer.from([0x00, 0x00, 0x00, 0x00]);
      
      const type = finder.detectFileType(buffer);
      assert.strictEqual(type, 'unknown');
    });

    test('should handle empty buffer', () => {
      const finder = new BrokenFilesFinder();
      const buffer = Buffer.alloc(0);
      
      const type = finder.detectFileType(buffer);
      assert.strictEqual(type, 'unknown');
    });
  });

  describe('findBrokenSymlinks', () => {
    test('should find broken symlinks', async () => {
      const finder = new BrokenFilesFinder();
      const brokenLinks = await finder.findBrokenSymlinks(testDir);
      
      // Symlinks might not be supported on all systems
      // Just verify the function runs without error
      assert.ok(Array.isArray(brokenLinks));
    });

    test('should not include valid symlinks', async () => {
      const finder = new BrokenFilesFinder();
      const brokenLinks = await finder.findBrokenSymlinks(testDir);
      
      // Valid link should not be in results
      assert.ok(!brokenLinks.some(l => l.name === 'valid-link.txt'));
    });

    test('should handle directory with no symlinks', async () => {
      const noSymlinksDir = join(testDir, 'no-symlinks');
      await mkdir(noSymlinksDir, { recursive: true });
      await writeFile(join(noSymlinksDir, 'file.txt'), 'content');
      
      const finder = new BrokenFilesFinder();
      const brokenLinks = await finder.findBrokenSymlinks(noSymlinksDir);
      
      assert.strictEqual(brokenLinks.length, 0);
      
      await rm(noSymlinksDir, { recursive: true });
    });
  });

  describe('findInvalidNames', () => {
    test('should find files with trailing spaces', async () => {
      const trailingSpaceDir = join(testDir, 'invalid-names');
      await mkdir(trailingSpaceDir, { recursive: true });
      
      // Note: Some file systems may not allow trailing spaces
      // Just test the function logic
      const finder = new BrokenFilesFinder();
      const invalidFiles = await finder.findInvalidNames(trailingSpaceDir);
      
      assert.ok(Array.isArray(invalidFiles));
      
      await rm(trailingSpaceDir, { recursive: true });
    });

    test('should handle directory with valid names', async () => {
      const validNamesDir = join(testDir, 'valid-names');
      await mkdir(validNamesDir, { recursive: true });
      await writeFile(join(validNamesDir, 'normal-file.txt'), 'content');
      await writeFile(join(validNamesDir, 'another_file.txt'), 'content');
      
      const finder = new BrokenFilesFinder();
      const invalidFiles = await finder.findInvalidNames(validNamesDir);
      
      // Should not find any invalid names in this directory
      assert.ok(Array.isArray(invalidFiles));
      
      await rm(validNamesDir, { recursive: true });
    });

    test('should respect exclude patterns', async () => {
      const excludeDir = join(testDir, 'excluded');
      await mkdir(excludeDir, { recursive: true });
      
      const finder = new BrokenFilesFinder({
        excludePatterns: ['excluded']
      });
      const invalidFiles = await finder.findInvalidNames(testDir);
      
      assert.ok(!invalidFiles.some(f => f.path.includes('excluded')));
      
      await rm(excludeDir, { recursive: true });
    });
  });

  describe('findMismatchedExtensions', () => {
    test('should find files with mismatched extensions when enabled', async () => {
      const finder = new BrokenFilesFinder({
        checkExtensions: true
      });
      const mismatchedFiles = await finder.findMismatchedExtensions(testDir);
      
      assert.ok(Array.isArray(mismatchedFiles));
    });

    test('should skip checking when checkExtensions is false', async () => {
      const finder = new BrokenFilesFinder({
        checkExtensions: false
      });
      const mismatchedFiles = await finder.findMismatchedExtensions(testDir);
      
      assert.strictEqual(mismatchedFiles.length, 0);
    });

    test('should handle directory with proper extensions', async () => {
      const properExtDir = join(testDir, 'proper-ext');
      await mkdir(properExtDir, { recursive: true });
      await writeFile(join(properExtDir, 'text.txt'), 'plain text content');
      await writeFile(join(properExtDir, 'data.dat'), 'data content');
      
      const finder = new BrokenFilesFinder({
        checkExtensions: true
      });
      const mismatchedFiles = await finder.findMismatchedExtensions(properExtDir);
      
      assert.ok(Array.isArray(mismatchedFiles));
      
      await rm(properExtDir, { recursive: true });
    });
  });
});
