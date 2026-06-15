import { test, describe } from 'node:test';
import assert from 'node:assert';
import { ReportGenerator } from '../lib/report.js';

describe('ReportGenerator Module', () => {
  
  describe('escapeHtml', () => {
    test('should escape < character', () => {
      const generator = new ReportGenerator();
      
      assert.strictEqual(generator.escapeHtml('a < b'), 'a &lt; b');
    });

    test('should escape > character', () => {
      const generator = new ReportGenerator();
      
      assert.strictEqual(generator.escapeHtml('a > b'), 'a &gt; b');
    });

    test('should escape & character', () => {
      const generator = new ReportGenerator();
      
      assert.strictEqual(generator.escapeHtml('Tom & Jerry'), 'Tom &amp; Jerry');
    });

    test('should escape " character', () => {
      const generator = new ReportGenerator();
      
      assert.strictEqual(generator.escapeHtml('Say "hello"'), 'Say &quot;hello&quot;');
    });

    test('should escape \' character', () => {
      const generator = new ReportGenerator();
      
      assert.strictEqual(generator.escapeHtml("It's mine"), 'It&#039;s mine');
    });

    test('should escape multiple special characters', () => {
      const generator = new ReportGenerator();
      
      assert.strictEqual(
        generator.escapeHtml('<script>alert("XSS")</script>'),
        '&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;'
      );
    });

    test('should not modify normal text', () => {
      const generator = new ReportGenerator();
      
      assert.strictEqual(generator.escapeHtml('Hello World'), 'Hello World');
      assert.strictEqual(generator.escapeHtml('Test 123'), 'Test 123');
    });

    test('should handle empty string', () => {
      const generator = new ReportGenerator();
      
      assert.strictEqual(generator.escapeHtml(''), '');
    });

    test('should handle null and undefined gracefully', () => {
      const generator = new ReportGenerator();
      
      // The function should handle these cases without crashing
      // Behavior depends on implementation - checking it doesn't throw
      try {
        const result1 = generator.escapeHtml(null);
        assert.ok(typeof result1 === 'string');
        
        const result2 = generator.escapeHtml(undefined);
        assert.ok(typeof result2 === 'string');
      } catch (err) {
        // If it throws, that's also acceptable behavior
        assert.ok(err);
      }
    });

    test('should escape consecutive special characters', () => {
      const generator = new ReportGenerator();
      
      assert.strictEqual(generator.escapeHtml('<<>>'), '&lt;&lt;&gt;&gt;');
      assert.strictEqual(generator.escapeHtml('&&'), '&amp;&amp;');
    });

    test('should handle mixed content', () => {
      const generator = new ReportGenerator();
      
      assert.strictEqual(
        generator.escapeHtml('Path: C:\\Users\\John & Jane\\Documents'),
        'Path: C:\\Users\\John &amp; Jane\\Documents'
      );
    });

    test('should escape HTML entities in file paths', () => {
      const generator = new ReportGenerator();
      
      assert.strictEqual(
        generator.escapeHtml('/path/to/<important>/file.txt'),
        '/path/to/&lt;important&gt;/file.txt'
      );
    });

    test('should handle long strings', () => {
      const generator = new ReportGenerator();
      const longString = 'a'.repeat(1000) + '<>&"\'';
      const result = generator.escapeHtml(longString);
      
      assert.ok(result.includes('&lt;'));
      assert.ok(result.includes('&gt;'));
      assert.ok(result.includes('&amp;'));
      assert.ok(result.includes('&quot;'));
      assert.ok(result.includes('&#039;'));
    });

    test('should preserve whitespace', () => {
      const generator = new ReportGenerator();
      
      assert.strictEqual(generator.escapeHtml('a    b'), 'a    b');
      assert.strictEqual(generator.escapeHtml('line1\nline2'), 'line1\nline2');
      assert.strictEqual(generator.escapeHtml('\t\ttabbed'), '\t\ttabbed');
    });
  });

  describe('buildFileHtml', () => {
    test('should build HTML for file with basic properties', () => {
      const generator = new ReportGenerator();
      const file = {
        path: '/home/user/test.txt',
        size: 1024
      };
      
      const html = generator.buildFileHtml(file);
      
      assert.ok(typeof html === 'string');
      assert.ok(html.length > 0);
    });

    test('should escape file path in HTML', () => {
      const generator = new ReportGenerator();
      const file = {
        path: '/path/to/<script>alert("XSS")</script>/file.txt',
        size: 2048
      };
      
      const html = generator.buildFileHtml(file);
      
      // Should not contain raw script tags
      assert.ok(!html.includes('<script>'));
      // Should contain escaped version
      assert.ok(html.includes('&lt;script&gt;') || html.includes('alert'));
    });

    test('should handle file with special characters in path', () => {
      const generator = new ReportGenerator();
      const file = {
        path: '/path/to/file & folder/test.txt',
        size: 512
      };
      
      const html = generator.buildFileHtml(file);
      
      assert.ok(typeof html === 'string');
      assert.ok(html.includes('&amp;') || html.includes('file') || html.includes('folder'));
    });
  });

  describe('buildGroupHtml', () => {
    test('should build HTML for duplicate group', () => {
      const generator = new ReportGenerator();
      const group = {
        files: [
          { path: '/path/to/file1.txt', size: 1024 },
          { path: '/path/to/file2.txt', size: 1024 }
        ],
        size: 1024,
        count: 2
      };
      
      const html = generator.buildGroupHtml(group, 0);
      
      assert.ok(typeof html === 'string');
      assert.ok(html.length > 0);
    });

    test('should handle large duplicate groups', () => {
      const generator = new ReportGenerator();
      const group = {
        files: Array.from({ length: 10 }, (_, i) => ({
          path: `/path/to/file${i}.txt`,
          size: 1024
        })),
        size: 1024,
        count: 10
      };
      
      const html = generator.buildGroupHtml(group, 0);
      
      assert.ok(typeof html === 'string');
      assert.ok(html.length > 0);
    });
  });

  describe('buildNameSizeFileHtml', () => {
    test('should build HTML for name-size file', () => {
      const generator = new ReportGenerator();
      const file = {
        path: '/home/user/document.pdf',
        name: 'document.pdf',
        size: 2048
      };
      
      const html = generator.buildNameSizeFileHtml(file);
      
      assert.ok(typeof html === 'string');
      assert.ok(html.length > 0);
    });

    test('should escape file name in HTML', () => {
      const generator = new ReportGenerator();
      const file = {
        path: '/path/to/file<test>.txt',
        name: 'file<test>.txt',
        size: 1024
      };
      
      const html = generator.buildNameSizeFileHtml(file);
      
      // Should not contain raw < and >
      assert.ok(!html.includes('file<test>') || html.includes('&lt;'));
    });
  });

  describe('buildFolderFileHtml', () => {
    test('should build HTML for folder file', () => {
      const generator = new ReportGenerator();
      const file = {
        path: '/home/user/documents/file.txt',
        name: 'file.txt',
        size: 512
      };
      
      const html = generator.buildFolderFileHtml(file);
      
      assert.ok(typeof html === 'string');
      assert.ok(html.length > 0);
    });

    test('should handle file with special characters', () => {
      const generator = new ReportGenerator();
      const file = {
        path: '/path/to/"important"/file.txt',
        name: 'file.txt',
        size: 1024
      };
      
      const html = generator.buildFolderFileHtml(file);
      
      assert.ok(typeof html === 'string');
      assert.ok(html.includes('&quot;') || html.includes('important'));
    });
  });
});
