import { test, describe } from 'node:test';
import assert from 'node:assert';
import { DatabaseManager } from '../lib/database.js';

describe('DatabaseManager Module', () => {
  
  describe('getFileExtension', () => {
    test('should extract extension from filename', () => {
      const db = new DatabaseManager();
      
      assert.strictEqual(db.getFileExtension('file.txt'), 'txt');
      assert.strictEqual(db.getFileExtension('document.pdf'), 'pdf');
      assert.strictEqual(db.getFileExtension('image.png'), 'png');
    });

    test('should handle files with multiple dots', () => {
      const db = new DatabaseManager();
      
      assert.strictEqual(db.getFileExtension('archive.tar.gz'), 'gz');
      assert.strictEqual(db.getFileExtension('my.file.name.txt'), 'txt');
    });

    test('should handle files without extension', () => {
      const db = new DatabaseManager();
      
      assert.strictEqual(db.getFileExtension('README'), '');
      assert.strictEqual(db.getFileExtension('Makefile'), '');
    });

    test('should handle hidden files', () => {
      const db = new DatabaseManager();
      
      assert.strictEqual(db.getFileExtension('.gitignore'), 'gitignore');
      assert.strictEqual(db.getFileExtension('.env'), 'env');
    });

    test('should handle empty string', () => {
      const db = new DatabaseManager();
      
      assert.strictEqual(db.getFileExtension(''), '');
    });

    test('should preserve case', () => {
      const db = new DatabaseManager();
      
      assert.strictEqual(db.getFileExtension('FILE.TXT'), 'TXT');
      assert.strictEqual(db.getFileExtension('Document.PDF'), 'PDF');
    });
  });

  describe('sanitizeForDb', () => {
    test('should return null for undefined', () => {
      const db = new DatabaseManager();
      
      assert.strictEqual(db.sanitizeForDb(undefined), null);
    });

    test('should return null for null', () => {
      const db = new DatabaseManager();
      
      assert.strictEqual(db.sanitizeForDb(null), null);
    });

    test('should return string as-is', () => {
      const db = new DatabaseManager();
      
      assert.strictEqual(db.sanitizeForDb('test'), 'test');
      assert.strictEqual(db.sanitizeForDb('hello world'), 'hello world');
    });

    test('should return number as-is', () => {
      const db = new DatabaseManager();
      
      assert.strictEqual(db.sanitizeForDb(123), 123);
      assert.strictEqual(db.sanitizeForDb(45.67), 45.67);
    });

    test('should return boolean as-is', () => {
      const db = new DatabaseManager();
      
      assert.strictEqual(db.sanitizeForDb(true), true);
      assert.strictEqual(db.sanitizeForDb(false), false);
    });

    test('should handle empty string', () => {
      const db = new DatabaseManager();
      
      assert.strictEqual(db.sanitizeForDb(''), '');
    });

    test('should handle zero', () => {
      const db = new DatabaseManager();
      
      assert.strictEqual(db.sanitizeForDb(0), 0);
    });
  });

  describe('cleanNumericValue', () => {
    test('should return null for undefined', () => {
      const db = new DatabaseManager();
      
      assert.strictEqual(db.cleanNumericValue(undefined), null);
    });

    test('should return null for null', () => {
      const db = new DatabaseManager();
      
      assert.strictEqual(db.cleanNumericValue(null), null);
    });

    test('should return number as-is', () => {
      const db = new DatabaseManager();
      
      assert.strictEqual(db.cleanNumericValue(123), 123);
      assert.strictEqual(db.cleanNumericValue(45.67), 45.67);
    });

    test('should parse numeric strings', () => {
      const db = new DatabaseManager();
      
      assert.strictEqual(db.cleanNumericValue('123'), 123);
      assert.strictEqual(db.cleanNumericValue('45.67'), 45.67);
    });

    test('should handle zero', () => {
      const db = new DatabaseManager();
      
      assert.strictEqual(db.cleanNumericValue(0), 0);
      assert.strictEqual(db.cleanNumericValue('0'), 0);
    });

    test('should return null for non-numeric strings', () => {
      const db = new DatabaseManager();
      
      assert.strictEqual(db.cleanNumericValue('abc'), null);
    });

    test('should parse leading numbers from mixed strings', () => {
      const db = new DatabaseManager();
      
      // parseFloat behavior - parses leading numbers
      assert.strictEqual(db.cleanNumericValue('12abc'), 12);
      assert.strictEqual(db.cleanNumericValue('45.67xyz'), 45.67);
    });

    test('should return null for empty string', () => {
      const db = new DatabaseManager();
      
      assert.strictEqual(db.cleanNumericValue(''), null);
    });

    test('should handle negative numbers', () => {
      const db = new DatabaseManager();
      
      assert.strictEqual(db.cleanNumericValue(-123), -123);
      assert.strictEqual(db.cleanNumericValue('-456'), -456);
    });
  });

  describe('cleanDateTimeValue', () => {
    test('should return null for undefined', () => {
      const db = new DatabaseManager();
      
      assert.strictEqual(db.cleanDateTimeValue(undefined), null);
    });

    test('should return null for null', () => {
      const db = new DatabaseManager();
      
      assert.strictEqual(db.cleanDateTimeValue(null), null);
    });

    test('should format Date object to MySQL datetime string', () => {
      const db = new DatabaseManager();
      const date = new Date('2024-01-01T12:00:00Z');
      
      const result = db.cleanDateTimeValue(date);
      assert.ok(typeof result === 'string');
      assert.ok(result.includes('2024'));
    });

    test('should parse and format valid date strings', () => {
      const db = new DatabaseManager();
      const dateStr = '2024-01-01T12:00:00Z';
      
      const result = db.cleanDateTimeValue(dateStr);
      assert.ok(typeof result === 'string');
      assert.ok(result.includes('2024'));
      assert.ok(result.includes('12:00:00'));
    });

    test('should return null for invalid date strings', () => {
      const db = new DatabaseManager();
      
      assert.strictEqual(db.cleanDateTimeValue('invalid-date'), null);
      assert.strictEqual(db.cleanDateTimeValue('abc'), null);
    });

    test('should return null for empty string', () => {
      const db = new DatabaseManager();
      
      assert.strictEqual(db.cleanDateTimeValue(''), null);
    });

    test('should return null for plain timestamp numbers', () => {
      const db = new DatabaseManager();
      const timestamp = 1704110400000; // 2024-01-01 12:00:00 UTC
      
      // Plain numbers are not handled - must be wrapped in Date object
      const result = db.cleanDateTimeValue(timestamp);
      assert.strictEqual(result, null);
    });
  });

  describe('isMigrationAlreadyAppliedError', () => {
    test('should return true for duplicate column error', () => {
      const db = new DatabaseManager();
      const err = { message: 'Duplicate column name col1' };
      
      assert.strictEqual(db.isMigrationAlreadyAppliedError(err), true);
    });

    test('should return true for already exists error', () => {
      const db = new DatabaseManager();
      const err = { message: 'Table already exists' };
      
      assert.strictEqual(db.isMigrationAlreadyAppliedError(err), true);
    });

    test('should return true for duplicate key error', () => {
      const db = new DatabaseManager();
      const err = { message: 'Error: duplicate key violation' };
      
      assert.strictEqual(db.isMigrationAlreadyAppliedError(err), true);
    });

    test('should return false for other errors', () => {
      const db = new DatabaseManager();
      const err = { message: 'Some other error' };
      
      assert.strictEqual(db.isMigrationAlreadyAppliedError(err), false);
    });

    test('should return false for connection error', () => {
      const db = new DatabaseManager();
      const err = { message: 'Connection refused' };
      
      assert.strictEqual(db.isMigrationAlreadyAppliedError(err), false);
    });
  });
});
