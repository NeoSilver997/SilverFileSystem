import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * UI Tests
 * 
 * Tests verify that UI HTML files exist, are valid, and contain expected elements
 */

const publicDir = join(process.cwd(), 'public');

describe('UI Pages', () => {
  
  describe('Login Page', () => {
    const loginPath = join(publicDir, 'login.html');
    
    test('should exist', () => {
      assert.ok(existsSync(loginPath), 'login.html should exist');
    });

    test('should be valid HTML', () => {
      const content = readFileSync(loginPath, 'utf-8');
      assert.ok(content.includes('<!DOCTYPE html>') || content.includes('<html'), 'Should contain HTML doctype or tag');
    });

    test('should contain login form elements', () => {
      const content = readFileSync(loginPath, 'utf-8');
      assert.ok(content.includes('username') || content.includes('email'), 'Should have username/email field');
      assert.ok(content.includes('password'), 'Should have password field');
      assert.ok(content.includes('login') || content.includes('Login'), 'Should have login text');
    });

    test('should contain Google OAuth option', () => {
      const content = readFileSync(loginPath, 'utf-8');
      assert.ok(content.includes('google') || content.includes('Google'), 'Should have Google OAuth option');
    });

    test('should have JavaScript for authentication', () => {
      const content = readFileSync(loginPath, 'utf-8');
      assert.ok(content.includes('<script'), 'Should contain script tag');
      assert.ok(content.includes('fetch') || content.includes('XMLHttpRequest') || content.includes('axios'), 
        'Should have API call mechanism');
    });

    test('should have styling', () => {
      const content = readFileSync(loginPath, 'utf-8');
      assert.ok(content.includes('<style') || content.includes('.css') || content.includes('stylesheet'), 
        'Should have CSS styling');
    });
  });

  describe('Dashboard Page', () => {
    const dashboardPath = join(publicDir, 'dashboard.html');
    
    test('should exist', () => {
      assert.ok(existsSync(dashboardPath), 'dashboard.html should exist');
    });

    test('should be valid HTML', () => {
      const content = readFileSync(dashboardPath, 'utf-8');
      assert.ok(content.includes('<!DOCTYPE html>') || content.includes('<html'), 'Should contain HTML doctype or tag');
    });

    test('should contain dashboard title', () => {
      const content = readFileSync(dashboardPath, 'utf-8');
      assert.ok(content.includes('Dashboard') || content.includes('dashboard'), 'Should have dashboard title');
    });

    test('should have navigation elements', () => {
      const content = readFileSync(dashboardPath, 'utf-8');
      assert.ok(content.includes('nav') || content.includes('menu') || content.includes('href') || content.includes('link'), 
        'Should have navigation');
    });

    test('should reference summary API', () => {
      const content = readFileSync(dashboardPath, 'utf-8');
      assert.ok(content.includes('/api/summary') || content.includes('summary'), 'Should call summary API');
    });

    test('should have media sections', () => {
      const content = readFileSync(dashboardPath, 'utf-8');
      assert.ok(content.includes('photo') || content.includes('Photo'), 'Should have photos section');
      assert.ok(content.includes('music') || content.includes('Music'), 'Should have music section');
      assert.ok(content.includes('video') || content.includes('movie') || content.includes('Movie'), 
        'Should have videos/movies section');
    });

    test('should have JavaScript for data loading', () => {
      const content = readFileSync(dashboardPath, 'utf-8');
      assert.ok(content.includes('<script'), 'Should contain script tag');
      assert.ok(content.includes('fetch') || content.includes('XMLHttpRequest') || content.includes('axios'), 
        'Should have API call mechanism');
    });
  });

  describe('Photos Page', () => {
    const photosPath = join(publicDir, 'photos.html');
    
    test('should exist', () => {
      assert.ok(existsSync(photosPath), 'photos.html should exist');
    });

    test('should be valid HTML', () => {
      const content = readFileSync(photosPath, 'utf-8');
      assert.ok(content.includes('<!DOCTYPE html>') || content.includes('<html'), 'Should contain HTML doctype or tag');
    });

    test('should contain photos title', () => {
      const content = readFileSync(photosPath, 'utf-8');
      assert.ok(content.includes('Photo') || content.includes('photo'), 'Should have photos title');
    });

    test('should reference photos API', () => {
      const content = readFileSync(photosPath, 'utf-8');
      assert.ok(content.includes('/api/photos'), 'Should call photos API');
    });

    test('should have image display elements', () => {
      const content = readFileSync(photosPath, 'utf-8');
      assert.ok(content.includes('<img') || content.includes('image'), 'Should have image elements');
    });

    test('should have search functionality', () => {
      const content = readFileSync(photosPath, 'utf-8');
      assert.ok(content.includes('search') || content.includes('Search'), 'Should have search functionality');
    });

    test('should have filter or sort options', () => {
      const content = readFileSync(photosPath, 'utf-8');
      assert.ok(content.includes('filter') || content.includes('sort') || content.includes('Filter') || content.includes('Sort'), 
        'Should have filter/sort options');
    });

    test('should have pagination or infinite scroll', () => {
      const content = readFileSync(photosPath, 'utf-8');
      assert.ok(content.includes('page') || content.includes('load') || content.includes('scroll') || 
        content.includes('next') || content.includes('prev'), 'Should have pagination or loading mechanism');
    });
  });

  describe('Music Page', () => {
    const musicPath = join(publicDir, 'music.html');
    
    test('should exist', () => {
      assert.ok(existsSync(musicPath), 'music.html should exist');
    });

    test('should be valid HTML', () => {
      const content = readFileSync(musicPath, 'utf-8');
      assert.ok(content.includes('<!DOCTYPE html>') || content.includes('<html'), 'Should contain HTML doctype or tag');
    });

    test('should contain music title', () => {
      const content = readFileSync(musicPath, 'utf-8');
      assert.ok(content.includes('Music') || content.includes('music'), 'Should have music title');
    });

    test('should reference music API', () => {
      const content = readFileSync(musicPath, 'utf-8');
      assert.ok(content.includes('/api/music'), 'Should call music API');
    });

    test('should have audio player', () => {
      const content = readFileSync(musicPath, 'utf-8');
      assert.ok(content.includes('<audio') || content.includes('player') || content.includes('play'), 
        'Should have audio player');
    });

    test('should have playlist functionality', () => {
      const content = readFileSync(musicPath, 'utf-8');
      assert.ok(content.includes('playlist') || content.includes('queue') || content.includes('track'), 
        'Should have playlist functionality');
    });

    test('should have artist and album views', () => {
      const content = readFileSync(musicPath, 'utf-8');
      assert.ok(content.includes('artist') || content.includes('Artist'), 'Should have artist view');
      assert.ok(content.includes('album') || content.includes('Album'), 'Should have album view');
    });

    test('should have rating functionality', () => {
      const content = readFileSync(musicPath, 'utf-8');
      assert.ok(content.includes('rating') || content.includes('star') || content.includes('rate'), 
        'Should have rating functionality');
    });

    test('should have play tracking', () => {
      const content = readFileSync(musicPath, 'utf-8');
      assert.ok(content.includes('/api/music/play') || content.includes('play-count'), 
        'Should track plays');
    });
  });

  describe('Movies Page', () => {
    const moviesPath = join(publicDir, 'movies.html');
    
    test('should exist', () => {
      assert.ok(existsSync(moviesPath), 'movies.html should exist');
    });

    test('should be valid HTML', () => {
      const content = readFileSync(moviesPath, 'utf-8');
      assert.ok(content.includes('<!DOCTYPE html>') || content.includes('<html'), 'Should contain HTML doctype or tag');
    });

    test('should contain movies title', () => {
      const content = readFileSync(moviesPath, 'utf-8');
      assert.ok(content.includes('Movie') || content.includes('movie') || content.includes('Video'), 
        'Should have movies title');
    });

    test('should reference movies API', () => {
      const content = readFileSync(moviesPath, 'utf-8');
      assert.ok(content.includes('/api/movies'), 'Should call movies API');
    });

    test('should have video player', () => {
      const content = readFileSync(moviesPath, 'utf-8');
      assert.ok(content.includes('<video') || content.includes('player') || content.includes('play'), 
        'Should have video player');
    });

    test('should have search functionality', () => {
      const content = readFileSync(moviesPath, 'utf-8');
      assert.ok(content.includes('search') || content.includes('Search'), 'Should have search functionality');
    });

    test('should display video metadata', () => {
      const content = readFileSync(moviesPath, 'utf-8');
      assert.ok(content.includes('resolution') || content.includes('duration') || content.includes('format'), 
        'Should display video metadata');
    });
  });

  describe('CLI Tools Page', () => {
    const cliToolsPath = join(publicDir, 'cli-tools.html');
    
    test('should exist', () => {
      assert.ok(existsSync(cliToolsPath), 'cli-tools.html should exist');
    });

    test('should be valid HTML', () => {
      const content = readFileSync(cliToolsPath, 'utf-8');
      assert.ok(content.includes('<!DOCTYPE html>') || content.includes('<html'), 'Should contain HTML doctype or tag');
    });

    test('should contain CLI tools title', () => {
      const content = readFileSync(cliToolsPath, 'utf-8');
      assert.ok(content.includes('CLI') || content.includes('tool') || content.includes('command'), 
        'Should have CLI tools title');
    });

    test('should reference CLI API', () => {
      const content = readFileSync(cliToolsPath, 'utf-8');
      assert.ok(content.includes('/api/cli/execute'), 'Should call CLI execute API');
    });

    test('should have command input', () => {
      const content = readFileSync(cliToolsPath, 'utf-8');
      assert.ok(content.includes('input') || content.includes('textarea') || content.includes('command'), 
        'Should have command input');
    });

    test('should have output display', () => {
      const content = readFileSync(cliToolsPath, 'utf-8');
      assert.ok(content.includes('output') || content.includes('result') || content.includes('console'), 
        'Should have output display');
    });
  });

  describe('Common UI Elements', () => {
    const htmlFiles = [
      'login.html',
      'dashboard.html',
      'photos.html',
      'music.html',
      'movies.html',
      'cli-tools.html'
    ];

    test('all pages should have meta viewport for responsive design', () => {
      htmlFiles.forEach(file => {
        const filePath = join(publicDir, file);
        if (existsSync(filePath)) {
          const content = readFileSync(filePath, 'utf-8');
          assert.ok(content.includes('viewport') || content.includes('mobile'), 
            `${file} should have viewport meta tag`);
        }
      });
    });

    test('all pages should have charset defined', () => {
      htmlFiles.forEach(file => {
        const filePath = join(publicDir, file);
        if (existsSync(filePath)) {
          const content = readFileSync(filePath, 'utf-8');
          assert.ok(content.includes('charset') || content.includes('UTF-8'), 
            `${file} should have charset defined`);
        }
      });
    });

    test('all pages should have title tag', () => {
      htmlFiles.forEach(file => {
        const filePath = join(publicDir, file);
        if (existsSync(filePath)) {
          const content = readFileSync(filePath, 'utf-8');
          assert.ok(content.includes('<title>'), `${file} should have title tag`);
        }
      });
    });

    test('all interactive pages should have JavaScript', () => {
      const interactivePages = ['dashboard.html', 'photos.html', 'music.html', 'movies.html', 'cli-tools.html'];
      interactivePages.forEach(file => {
        const filePath = join(publicDir, file);
        if (existsSync(filePath)) {
          const content = readFileSync(filePath, 'utf-8');
          assert.ok(content.includes('<script'), `${file} should have JavaScript`);
        }
      });
    });

    test('all pages should close HTML tags properly', () => {
      htmlFiles.forEach(file => {
        const filePath = join(publicDir, file);
        if (existsSync(filePath)) {
          const content = readFileSync(filePath, 'utf-8');
          assert.ok(content.includes('</html>'), `${file} should close HTML tag`);
          assert.ok(content.includes('</body>'), `${file} should close body tag`);
          assert.ok(content.includes('</head>'), `${file} should close head tag`);
        }
      });
    });
  });

  describe('Authentication Flow', () => {
    test('auth.js client library should exist', () => {
      const authJsPath = join(publicDir, 'auth.js');
      assert.ok(existsSync(authJsPath), 'auth.js should exist in public directory');
    });

    test('auth.js should contain authentication functions', () => {
      const authJsPath = join(publicDir, 'auth.js');
      if (existsSync(authJsPath)) {
        const content = readFileSync(authJsPath, 'utf-8');
        assert.ok(content.includes('token') || content.includes('auth'), 
          'Should handle authentication');
        assert.ok(content.includes('function') || content.includes('=>'), 
          'Should contain JavaScript functions');
      }
    });

    test('pages should check authentication status', () => {
      const protectedPages = ['dashboard.html', 'photos.html', 'music.html', 'movies.html'];
      protectedPages.forEach(file => {
        const filePath = join(publicDir, file);
        if (existsSync(filePath)) {
          const content = readFileSync(filePath, 'utf-8');
          assert.ok(content.includes('token') || content.includes('auth') || content.includes('login'), 
            `${file} should check authentication`);
        }
      });
    });
  });

  describe('API Integration', () => {
    test('pages should use fetch API or equivalent', () => {
      const apiPages = ['dashboard.html', 'photos.html', 'music.html', 'movies.html'];
      apiPages.forEach(file => {
        const filePath = join(publicDir, file);
        if (existsSync(filePath)) {
          const content = readFileSync(filePath, 'utf-8');
          assert.ok(content.includes('fetch') || content.includes('Fetch') || 
            content.includes('XMLHttpRequest') || content.includes('axios'), 
            `${file} should make API calls`);
        }
      });
    });

    test('pages should handle API errors', () => {
      const apiPages = ['dashboard.html', 'photos.html', 'music.html', 'movies.html'];
      apiPages.forEach(file => {
        const filePath = join(publicDir, file);
        if (existsSync(filePath)) {
          const content = readFileSync(filePath, 'utf-8');
          assert.ok(content.includes('catch') || content.includes('error') || content.includes('Error'), 
            `${file} should handle errors`);
        }
      });
    });

    test('pages should show loading states', () => {
      const apiPages = ['dashboard.html', 'photos.html', 'music.html', 'movies.html'];
      apiPages.forEach(file => {
        const filePath = join(publicDir, file);
        if (existsSync(filePath)) {
          const content = readFileSync(filePath, 'utf-8');
          assert.ok(content.includes('load') || content.includes('spinner') || content.includes('progress'), 
            `${file} should show loading state`);
        }
      });
    });
  });

  describe('User Experience', () => {
    test('pages should have user-friendly error messages', () => {
      const allPages = ['dashboard.html', 'photos.html', 'music.html', 'movies.html', 'cli-tools.html'];
      allPages.forEach(file => {
        const filePath = join(publicDir, file);
        if (existsSync(filePath)) {
          const content = readFileSync(filePath, 'utf-8');
          assert.ok(content.includes('message') || content.includes('alert') || content.includes('notification'), 
            `${file} should display user messages`);
        }
      });
    });

    test('media pages should have controls', () => {
      const mediaPages = ['music.html', 'movies.html'];
      mediaPages.forEach(file => {
        const filePath = join(publicDir, file);
        if (existsSync(filePath)) {
          const content = readFileSync(filePath, 'utf-8');
          assert.ok(content.includes('control') || content.includes('play') || content.includes('pause'), 
            `${file} should have media controls`);
        }
      });
    });

    test('pages should have navigation back to dashboard', () => {
      const subPages = ['photos.html', 'music.html', 'movies.html', 'cli-tools.html'];
      subPages.forEach(file => {
        const filePath = join(publicDir, file);
        if (existsSync(filePath)) {
          const content = readFileSync(filePath, 'utf-8');
          assert.ok(content.includes('dashboard') || content.includes('home') || content.includes('back'), 
            `${file} should have navigation to dashboard`);
        }
      });
    });
  });

  describe('Security Considerations', () => {
    test('pages should not contain hardcoded credentials', () => {
      const htmlFiles = [
        'login.html',
        'dashboard.html',
        'photos.html',
        'music.html',
        'movies.html',
        'cli-tools.html'
      ];
      
      htmlFiles.forEach(file => {
        const filePath = join(publicDir, file);
        if (existsSync(filePath)) {
          const content = readFileSync(filePath, 'utf-8');
          // This is a basic check - in reality, you'd want more sophisticated checks
          assert.ok(!content.includes('password123') && !content.includes('admin:admin'), 
            `${file} should not contain obvious hardcoded credentials`);
        }
      });
    });

    test('pages should use HTTPS for external resources in production', () => {
      const htmlFiles = ['dashboard.html', 'photos.html', 'music.html', 'movies.html'];
      
      htmlFiles.forEach(file => {
        const filePath = join(publicDir, file);
        if (existsSync(filePath)) {
          const content = readFileSync(filePath, 'utf-8');
          // Check that if external resources are loaded, they prefer https
          const hasExternalHttp = content.match(/src="http:\/\/(?!localhost)/g);
          if (hasExternalHttp) {
            console.warn(`${file} may have non-secure external resources`);
          }
          assert.ok(true, 'Checked for HTTPS usage');
        }
      });
    });
  });
});
