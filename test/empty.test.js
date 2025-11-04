import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { EmptyFinder } from '../lib/empty.js';

describe('EmptyFinder Module', () => {
  const testDir = '/tmp/test-empty';
  
  before(async () => {
    // Create test directory structure
    await mkdir(testDir, { recursive: true });
    await mkdir(join(testDir, 'empty-dir'), { recursive: true });
    await mkdir(join(testDir, 'non-empty-dir'), { recursive: true });
    await mkdir(join(testDir, 'subdir', 'nested-empty'), { recursive: true });
    
    // Create test files
    await writeFile(join(testDir, 'empty-file.txt'), '');
    await writeFile(join(testDir, 'non-empty-file.txt'), 'Content');
    await writeFile(join(testDir, 'non-empty-dir', 'file.txt'), 'Data');
    await writeFile(join(testDir, 'subdir', 'another-empty.txt'), '');
  });

  after(async () => {
    // Clean up test directory
    await rm(testDir, { recursive: true, force: true });
  });

  describe('shouldExclude', () => {
    test('should exclude paths matching string patterns', () => {
      const finder = new EmptyFinder({
        excludePatterns: ['node_modules', '.git']
      });
      
      assert.strictEqual(finder.shouldExclude('/path/to/node_modules/file.js'), true);
      assert.strictEqual(finder.shouldExclude('/path/to/.git/config'), true);
      assert.strictEqual(finder.shouldExclude('/path/to/src/file.js'), false);
    });

    test('should exclude paths matching regex patterns', () => {
      const finder = new EmptyFinder({
        excludePatterns: [/\.log$/, /tmp/]
      });
      
      assert.strictEqual(finder.shouldExclude('/path/to/file.log'), true);
      assert.strictEqual(finder.shouldExclude('/tmp/file.txt'), true);
      assert.strictEqual(finder.shouldExclude('/path/to/file.txt'), false);
    });

    test('should not exclude when no patterns match', () => {
      const finder = new EmptyFinder({
        excludePatterns: ['cache']
      });
      
      assert.strictEqual(finder.shouldExclude('/path/to/file.txt'), false);
    });

    test('should handle empty pattern list', () => {
      const finder = new EmptyFinder({
        excludePatterns: []
      });
      
      assert.strictEqual(finder.shouldExclude('/any/path/file.txt'), false);
    });
  });

  describe('findEmptyFiles', () => {
    test('should find empty files in directory', async () => {
      const finder = new EmptyFinder();
      const emptyFiles = await finder.findEmptyFiles(testDir);
      
      assert.ok(emptyFiles.length >= 2);
      assert.ok(emptyFiles.some(f => f.name === 'empty-file.txt'));
      assert.ok(emptyFiles.some(f => f.name === 'another-empty.txt'));
    });

    test('should not include non-empty files', async () => {
      const finder = new EmptyFinder();
      const emptyFiles = await finder.findEmptyFiles(testDir);
      
      assert.ok(!emptyFiles.some(f => f.name === 'non-empty-file.txt'));
      assert.ok(!emptyFiles.some(f => f.name === 'file.txt'));
    });

    test('should include file metadata', async () => {
      const finder = new EmptyFinder();
      const emptyFiles = await finder.findEmptyFiles(testDir);
      
      const file = emptyFiles.find(f => f.name === 'empty-file.txt');
      assert.ok(file);
      assert.ok(file.path);
      assert.ok(file.name);
      assert.strictEqual(file.type, 'file');
    });

    test('should respect exclude patterns', async () => {
      const excludeDir = join(testDir, 'excluded');
      await mkdir(excludeDir, { recursive: true });
      await writeFile(join(excludeDir, 'empty.txt'), '');
      
      const finder = new EmptyFinder({
        excludePatterns: ['excluded']
      });
      const emptyFiles = await finder.findEmptyFiles(testDir);
      
      assert.ok(!emptyFiles.some(f => f.path.includes('excluded')));
      
      await rm(excludeDir, { recursive: true });
    });

    test('should handle directory with no empty files', async () => {
      const noEmptyDir = join(testDir, 'no-empty');
      await mkdir(noEmptyDir, { recursive: true });
      await writeFile(join(noEmptyDir, 'file1.txt'), 'content1');
      await writeFile(join(noEmptyDir, 'file2.txt'), 'content2');
      
      const finder = new EmptyFinder();
      const emptyFiles = await finder.findEmptyFiles(noEmptyDir);
      
      assert.strictEqual(emptyFiles.length, 0);
      
      await rm(noEmptyDir, { recursive: true });
    });

    test('should handle completely empty directory', async () => {
      const completelyEmpty = join(testDir, 'completely-empty');
      await mkdir(completelyEmpty, { recursive: true });
      
      const finder = new EmptyFinder();
      const emptyFiles = await finder.findEmptyFiles(completelyEmpty);
      
      assert.strictEqual(emptyFiles.length, 0);
      
      await rm(completelyEmpty, { recursive: true });
    });
  });

  describe('findEmptyDirectories', () => {
    test('should find empty directories', async () => {
      const finder = new EmptyFinder();
      const emptyDirs = await finder.findEmptyDirectories(testDir);
      
      assert.ok(emptyDirs.length > 0);
      assert.ok(emptyDirs.some(d => d.name === 'empty-dir'));
    });

    test('should not include non-empty directories', async () => {
      const finder = new EmptyFinder();
      const emptyDirs = await finder.findEmptyDirectories(testDir);
      
      assert.ok(!emptyDirs.some(d => d.name === 'non-empty-dir'));
    });

    test('should include directory metadata', async () => {
      const finder = new EmptyFinder();
      const emptyDirs = await finder.findEmptyDirectories(testDir);
      
      const dir = emptyDirs.find(d => d.name === 'empty-dir');
      assert.ok(dir);
      assert.ok(dir.path);
      assert.ok(dir.name);
      assert.strictEqual(dir.type, 'directory');
    });

    test('should find nested empty directories', async () => {
      const finder = new EmptyFinder();
      const emptyDirs = await finder.findEmptyDirectories(testDir);
      
      assert.ok(emptyDirs.some(d => d.name === 'nested-empty'));
    });

    test('should respect exclude patterns', async () => {
      const excludeDir = join(testDir, 'excluded-empty');
      await mkdir(excludeDir, { recursive: true });
      
      const finder = new EmptyFinder({
        excludePatterns: ['excluded']
      });
      const emptyDirs = await finder.findEmptyDirectories(testDir);
      
      assert.ok(!emptyDirs.some(d => d.path.includes('excluded')));
      
      await rm(excludeDir, { recursive: true });
    });

    test('should handle directory with only subdirectories', async () => {
      const parentDir = join(testDir, 'parent-only-dirs');
      const childDir = join(parentDir, 'child');
      await mkdir(childDir, { recursive: true });
      await writeFile(join(childDir, 'file.txt'), 'content');
      
      const finder = new EmptyFinder();
      const emptyDirs = await finder.findEmptyDirectories(parentDir);
      
      // Parent has a child with files, so parent should not be empty
      assert.ok(!emptyDirs.some(d => d.path === parentDir));
      
      await rm(parentDir, { recursive: true });
    });
  });
});
