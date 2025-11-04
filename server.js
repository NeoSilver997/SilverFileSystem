#!/usr/bin/env node

import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import session from 'express-session';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import morgan from 'morgan';
import { DatabaseManager } from './lib/database.js';
import { AuthManager, authMiddleware, adminMiddleware, requirePhotoPermission, requireMusicPermission, requireVideoPermission } from './lib/auth.js';
import { loadConfig } from './lib/utils.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import path from 'path';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const config = loadConfig();

// Enable access logging
app.use(morgan('combined', { stream: fs.createWriteStream('access.log', { flags: 'a' }) }));

// Rate limiting middleware
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});

const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: 'Too many requests from this IP, please try again later.'
});

// Higher limit for media streaming (images, audio, video)
const mediaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500, // Higher limit for media files
  message: 'Too many media requests from this IP, please try again later.'
});

// Very strict rate limiting for authentication endpoints to prevent brute force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Only 10 login attempts per 15 minutes
  message: 'Too many login attempts from this IP, please try again later.',
  skipSuccessfulRequests: false // Count both successful and failed attempts
});

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:4000',
  credentials: true
}));
app.use(express.json());
app.use(express.static('public'));
app.use('/api/', apiLimiter);

// Session configuration for OAuth
app.use(session({
  secret: process.env.SESSION_SECRET || 'silverfilesystem-session-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Initialize Passport
app.use(passport.initialize());
app.use(passport.session());

// Database connection
let db = null;
let authManager = null;

// Authentication middleware (initialized after database connection)
let requireAuth = null;
let requireAdmin = null;

// Google OAuth setup
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || ''; // Set in .env file
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// Initialize database
async function initDatabase(dbConfig = {}) {
  const finalConfig = {
    host: dbConfig.host || config.database.host,
    port: parseInt(dbConfig.port || config.database.port),
    user: dbConfig.user || config.database.user,
    password: dbConfig.password || config.database.password,
    database: dbConfig.database || config.database.database
  };

  db = new DatabaseManager(finalConfig);
  await db.connect();
  console.log('✓ Connected to database');

  // Initialize authentication
  authManager = new AuthManager(db);
  await authManager.initializeUsersTable();
  await authManager.createDefaultUser();

  // Create middleware instances with authManager
  requireAuth = authMiddleware(authManager);
  requireAdmin = adminMiddleware(authManager);

  // Configure Google OAuth Strategy
  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const callbackURL = process.env.GOOGLE_CALLBACK_URL || 'http://localhost:4000/api/auth/google/callback';

  if (googleClientId && googleClientSecret) {
    passport.use(new GoogleStrategy({
      clientID: googleClientId,
      clientSecret: googleClientSecret,
      callbackURL: callbackURL
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const user = await authManager.findOrCreateGoogleUser(profile);
        return done(null, user);
      } catch (err) {
        return done(err, null);
      }
    }));

    // Passport serialization
    passport.serializeUser((user, done) => {
      done(null, user.id);
    });

    passport.deserializeUser(async (id, done) => {
      try {
        const [users] = await db.connection.query(
          'SELECT id, username, email, profile_picture FROM users WHERE id = ?',
          [id]
        );
        if (users.length > 0) {
          done(null, users[0]);
        } else {
          done(new Error('User not found'), null);
        }
      } catch (err) {
        done(err, null);
      }
    });

    console.log('✓ Google OAuth configured');
  } else {
    console.log('ℹ️  Google OAuth not configured (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable)');
  }

  // Serve image files (after database is initialized)
  app.get('/images/:id', requireAuth, requirePhotoPermission, mediaLimiter, async (req, res) => {
    try {
      const fileId = req.params.id;

      // Get file path from database
      const photo = await db.connection.query(
        'SELECT path FROM scanned_files WHERE id = ?',
        [fileId]
      );

      if (photo[0].length === 0) {
        return res.status(404).json({ error: 'Image not found' });
      }

      const filePath = photo[0][0].path;

      // Check if file exists
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found on disk' });
      }

      // Set appropriate content type based on file extension
      const ext = path.extname(filePath).toLowerCase();
      const contentTypes = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.bmp': 'image/bmp',
        '.tiff': 'image/tiff',
        '.webp': 'image/webp',
        '.heic': 'image/heic',
        '.heif': 'image/heif'
      };

      const contentType = contentTypes[ext] || 'application/octet-stream';
      res.setHeader('Content-Type', contentType);

      // Stream the file
      const fileStream = fs.createReadStream(filePath);
      fileStream.pipe(res);

      fileStream.on('error', (err) => {
        console.error('Error streaming file:', err);
        res.status(500).json({ error: 'Error serving image' });
      });

    } catch (err) {
      console.error('Error serving image:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Serve audio files
  app.get('/audio/:id', requireAuth, requireMusicPermission, mediaLimiter, async (req, res) => {
    try {
      const fileId = req.params.id;

      // Get file path from database
      const audio = await db.connection.query(
        'SELECT path FROM scanned_files WHERE id = ?',
        [fileId]
      );

      if (audio[0].length === 0) {
        return res.status(404).json({ error: 'Audio not found' });
      }

      const filePath = audio[0][0].path;

      // Check if file exists
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found on disk' });
      }

      // Set appropriate content type
      const ext = path.extname(filePath).toLowerCase();
      const contentTypes = {
        '.mp3': 'audio/mpeg',
        '.flac': 'audio/flac',
        '.wav': 'audio/wav',
        '.aac': 'audio/aac',
        '.m4a': 'audio/mp4',
        '.ogg': 'audio/ogg',
        '.wma': 'audio/x-ms-wma',
        '.opus': 'audio/opus'
      };

      const contentType = contentTypes[ext] || 'audio/mpeg';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Accept-Ranges', 'bytes');

      // Record play history (async, don't wait)
      const ip = req.ip || req.connection.remoteAddress;
      authManager.recordPlayHistory(req.user.id, fileId, ip).catch(err => 
        console.error('Failed to record play history:', err)
      );

      // Get file stats
      const stat = fs.statSync(filePath);
      const fileSize = stat.size;
      const range = req.headers.range;

      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        
        // Validate range values
        if (isNaN(start) || isNaN(end) || start < 0 || end >= fileSize || start > end) {
          return res.status(416).json({ error: 'Invalid range' });
        }
        
        const chunksize = (end - start) + 1;
        const fileStream = fs.createReadStream(filePath, { start, end });
        const head = {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Content-Length': chunksize,
          'Content-Type': contentType,
        };
        res.writeHead(206, head);
        fileStream.pipe(res);
      } else {
        const head = {
          'Content-Length': fileSize,
          'Content-Type': contentType,
        };
        res.writeHead(200, head);
        fs.createReadStream(filePath).pipe(res);
      }

    } catch (err) {
      console.error('Error serving audio:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Serve video files
  app.get('/video/:id', requireAuth, requireVideoPermission, mediaLimiter, async (req, res) => {
    try {
      const fileId = req.params.id;

      // Get file path from database
      const video = await db.connection.query(
        'SELECT path FROM scanned_files WHERE id = ?',
        [fileId]
      );

      if (video[0].length === 0) {
        return res.status(404).json({ error: 'Video not found' });
      }

      const filePath = video[0][0].path;

      // Check if file exists
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found on disk' });
      }

      // Set appropriate content type
      const ext = path.extname(filePath).toLowerCase();
      const contentTypes = {
        '.mp4': 'video/mp4',
        '.mkv': 'video/x-matroska',
        '.avi': 'video/x-msvideo',
        '.mov': 'video/quicktime',
        '.wmv': 'video/x-ms-wmv',
        '.flv': 'video/x-flv',
        '.webm': 'video/webm',
        '.m4v': 'video/mp4',
        '.mpeg': 'video/mpeg'
      };

      const contentType = contentTypes[ext] || 'video/mp4';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Accept-Ranges', 'bytes');

      // Record play history (async, don't wait)
      const ip = req.ip || req.connection.remoteAddress;
      authManager.recordPlayHistory(req.user.id, fileId, ip).catch(err => 
        console.error('Failed to record play history:', err)
      );

      // Get file stats
      const stat = fs.statSync(filePath);
      const fileSize = stat.size;
      const range = req.headers.range;

      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        
        // Validate range values
        if (isNaN(start) || isNaN(end) || start < 0 || end >= fileSize || start > end) {
          return res.status(416).json({ error: 'Invalid range' });
        }
        
        const chunksize = (end - start) + 1;
        const fileStream = fs.createReadStream(filePath, { start, end });
        const head = {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Content-Length': chunksize,
          'Content-Type': contentType,
        };
        res.writeHead(206, head);
        fileStream.pipe(res);
      } else {
        const head = {
          'Content-Length': fileSize,
          'Content-Type': contentType,
        };
        res.writeHead(200, head);
        fs.createReadStream(filePath).pipe(res);
      }

    } catch (err) {
      console.error('Error serving video:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ==================== ADMIN ROUTES ====================

  // Get all users (admin only)
  app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
    try {
      const users = await authManager.getAllUsers();
      res.json({ users });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get pending users (admin only)
  app.get('/api/admin/users/pending', requireAuth, requireAdmin, async (req, res) => {
    try {
      const users = await authManager.getPendingUsers();
      res.json({ users });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Enable a user (admin only)
  app.post('/api/admin/users/:id/enable', requireAuth, requireAdmin, async (req, res) => {
    try {
      const userId = parseInt(req.params.id);
      if (isNaN(userId)) {
        return res.status(400).json({ error: 'Invalid user ID' });
      }
      
      const result = await authManager.enableUser(userId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Disable a user (admin only)
  app.post('/api/admin/users/:id/disable', requireAuth, requireAdmin, async (req, res) => {
    try {
      const userId = parseInt(req.params.id);
      if (isNaN(userId)) {
        return res.status(400).json({ error: 'Invalid user ID' });
      }
      
      const result = await authManager.disableUser(userId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get user permissions (admin only)
  app.get('/api/admin/users/:id/permissions', requireAuth, requireAdmin, async (req, res) => {
    try {
      const userId = parseInt(req.params.id);
      if (isNaN(userId)) {
        return res.status(400).json({ error: 'Invalid user ID' });
      }
      
      const permissions = await authManager.getUserPermissions(userId);
      res.json({ permissions });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update user permissions (admin only)
  app.post('/api/admin/users/:id/permissions', requireAuth, requireAdmin, async (req, res) => {
    try {
      const userId = parseInt(req.params.id);
      if (isNaN(userId)) {
        return res.status(400).json({ error: 'Invalid user ID' });
      }
      
      const { photos, music, videos } = req.body;
      const permissions = {};
      
      if (photos !== undefined) permissions.photos = photos;
      if (music !== undefined) permissions.music = music;
      if (videos !== undefined) permissions.videos = videos;
      
      const result = await authManager.updateUserPermissions(userId, permissions);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

// Helper function to format bytes
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ==================== AUTHENTICATION ROUTES ====================

// Login endpoint - rate limited to prevent brute force attacks
app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await authManager.login(username, password);
    
    // Record login history
    const ip = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];
    await authManager.recordLoginHistory(result.user.id, ip, 'local', userAgent);
    
    res.json(result);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// Register endpoint - rate limited to prevent abuse
app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await authManager.register(username, password);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Verify token endpoint
app.get('/api/auth/verify', (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.json({ valid: false });
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      return res.json({ valid: false });
    }

    const token = parts[1];
    const result = authManager.verifyToken(token);
    res.json(result);
  } catch (err) {
    res.json({ valid: false });
  }
});

// Google OAuth routes
app.get('/api/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/api/auth/google/callback',
  passport.authenticate('google', { 
    failureRedirect: '/login.html?error=google_auth_failed',
    session: true
  }),
  async (req, res) => {
    try {
      // Generate JWT token for the authenticated user
      const result = authManager.generateTokenForUser(req.user);
      
      // Record login history
      const ip = req.ip || req.connection.remoteAddress;
      await authManager.recordLoginHistory(req.user.id, ip, 'google');
      
      // Redirect to frontend with token
      res.redirect(`/login.html?token=${result.token}&user=${encodeURIComponent(JSON.stringify(result.user))}`);
    } catch (err) {
      console.error('Google OAuth callback error:', err);
      res.redirect('/login.html?error=auth_failed');
    }
  }
);

// ==================== API ROUTES ====================

// Health check (no auth required)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', database: db ? 'connected' : 'disconnected' });
});

// Cached summary data
let summaryCache = null;
let summaryCacheTime = 0;
const SUMMARY_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Get cached summary statistics for dashboard header
app.get('/api/summary', requireAuth, async (req, res) => {
  try {
    const now = Date.now();
    
    // Return cached data if still valid
    if (summaryCache && (now - summaryCacheTime) < SUMMARY_CACHE_DURATION) {
      return res.json(summaryCache);
    }
    
    // Fetch fresh data from all APIs
    const [photosData, musicData, moviesData] = await Promise.all([
      db.getPhotosWithMetadata(),
      db.getMusicWithMetadata(),
      db.getVideosWithMetadata()
    ]);
    
    // Calculate totals
    const totalFiles = photosData.length + musicData.length + moviesData.length;
    
    // Calculate total size in bytes
    const parseSizeToBytes = (sizeStr) => {
      if (!sizeStr) return 0;
      const match = sizeStr.match(/^([\d.]+)\s*([A-Z]+)$/);
      if (!match) return 0;
      const value = parseFloat(match[1]);
      const unit = match[2];
      const multipliers = { 'B': 1, 'KB': 1024, 'MB': 1024*1024, 'GB': 1024*1024*1024, 'TB': 1024*1024*1024*1024 };
      return value * (multipliers[unit] || 0);
    };
    
    let totalBytes = 0;
    photosData.forEach(p => totalBytes += Number(p.size || 0));
    musicData.forEach(m => totalBytes += Number(m.size || 0));
    moviesData.forEach(m => totalBytes += Number(m.size || 0));
    
    // Calculate total duration in minutes
    const parseDuration = (durationStr) => {
      if (!durationStr) return 0;
      const match = durationStr.match(/(\d+)h\s*(\d+)m/);
      if (!match) return 0;
      return parseInt(match[1]) * 60 + parseInt(match[2]);
    };
    
    let totalMinutes = 0;
    musicData.forEach(m => totalMinutes += parseDuration(m.duration || ''));
    moviesData.forEach(m => totalMinutes += parseDuration(m.duration || ''));
    
    const totalHours = Math.floor(totalMinutes / 60);
    const remainingMinutes = totalMinutes % 60;
    
    // Calculate detailed stats for each media type
    const photosStats = {
      totalPhotos: photosData.length,
      totalSize: formatBytes(photosData.reduce((sum, p) => sum + Number(p.size || 0), 0)),
      uniqueCameras: new Set(photosData.map(p => p.camera_make).filter(Boolean)).size,
      withGPS: photosData.filter(p => p.latitude !== null).length
    };

    const musicStats = {
      totalTracks: musicData.length,
      totalSize: formatBytes(musicData.reduce((sum, m) => sum + Number(m.size || 0), 0)),
      totalArtists: new Set(musicData.map(m => m.artist).filter(Boolean)).size,
      totalAlbums: new Set(musicData.map(m => m.album).filter(Boolean)).size
    };

    const moviesStats = {
      totalMovies: moviesData.length,
      totalSize: formatBytes(moviesData.reduce((sum, m) => sum + Number(m.size || 0), 0)),
      hdCount: moviesData.filter(m => m.width >= 1280 && m.width < 3840).length,
      fourKCount: moviesData.filter(m => m.width >= 3840).length
    };

    // Create summary object
    const summary = {
      totalFiles,
      totalSize: formatBytes(totalBytes),
      totalSizeBytes: totalBytes,
      totalDuration: `${totalHours}h ${remainingMinutes}m`,
      totalDurationMinutes: totalMinutes,
      breakdown: {
        photos: photosStats,
        music: musicStats,
        movies: moviesStats
      },
      lastUpdated: new Date().toISOString(),
      cacheExpiry: new Date(now + SUMMARY_CACHE_DURATION).toISOString()
    };
    
    // Cache the summary
    summaryCache = summary;
    summaryCacheTime = now;
    
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get file type breakdown statistics
app.get('/api/file-type-breakdown', async (req, res) => {
  try {
    const connection = db.connection;
    if (!connection) {
      throw new Error('Database not connected');
    }
    
    // Define file type categories with their extensions
    const fileTypeCategories = {
      script: ['.js', '.py', '.sh', '.bat', '.cmd', '.ps1', '.rb', '.pl', '.php', '.java', '.c', '.cpp', '.cs', '.go', '.rs', '.ts', '.jsx', '.tsx', '.vue', '.swift', '.kt'],
      document: ['.pdf', '.doc', '.docx', '.txt', '.rtf', '.odt', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.md', '.tex'],
      image: ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.svg', '.webp', '.ico', '.tiff', '.tif', '.heic', '.raw', '.cr2', '.nef'],
      music: ['.mp3', '.flac', '.wav', '.aac', '.ogg', '.m4a', '.wma', '.opus', '.ape'],
      video: ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg', '.3gp'],
      log: ['.log', '.out', '.err'],
      game: ['.exe', '.apk', '.ipa', '.app', '.dmg', '.iso', '.rom', '.sav'],
      system: ['.dll', '.sys', '.so', '.dylib', '.ini', '.cfg', '.conf', '.config'],
      program: ['.exe', '.msi', '.deb', '.rpm', '.pkg', '.appimage', '.snap']
    };
    
    // Query to get size breakdown by extension
    const [rows] = await connection.query(`
      SELECT 
        LOWER(extension) as ext,
        COUNT(*) as count,
        SUM(size) as total_size
      FROM scanned_files
      WHERE extension IS NOT NULL AND extension != ''
      GROUP BY LOWER(extension)
      ORDER BY total_size DESC
    `);
    
    // Categorize files
    const breakdown = {
      script: { count: 0, size: 0, extensions: [] },
      document: { count: 0, size: 0, extensions: [] },
      image: { count: 0, size: 0, extensions: [] },
      music: { count: 0, size: 0, extensions: [] },
      video: { count: 0, size: 0, extensions: [] },
      log: { count: 0, size: 0, extensions: [] },
      game: { count: 0, size: 0, extensions: [] },
      system: { count: 0, size: 0, extensions: [] },
      program: { count: 0, size: 0, extensions: [] },
      other: { count: 0, size: 0, extensions: [] }
    };
    
    // Categorize each extension
    rows.forEach(row => {
      const ext = row.ext.toLowerCase();
      const extWithDot = ext.startsWith('.') ? ext : '.' + ext;
      const count = parseInt(row.count);
      const size = parseInt(row.total_size);
      
      let categorized = false;
      for (const [category, extensions] of Object.entries(fileTypeCategories)) {
        if (extensions.includes(extWithDot)) {
          breakdown[category].count += count;
          breakdown[category].size += size;
          breakdown[category].extensions.push({ ext: extWithDot, count, size });
          categorized = true;
          break;
        }
      }
      
      if (!categorized) {
        breakdown.other.count += count;
        breakdown.other.size += size;
        breakdown.other.extensions.push({ ext: extWithDot, count, size });
      }
    });
    
    // Calculate total
    let totalFiles = 0;
    let totalSize = 0;
    Object.values(breakdown).forEach(category => {
      totalFiles += category.count;
      totalSize += category.size;
    });
    
    // Format the response
    const response = {
      total: {
        files: totalFiles,
        size: totalSize,
        sizeFormatted: formatBytes(totalSize)
      },
      categories: {}
    };
    
    // Add formatted data for each category
    Object.entries(breakdown).forEach(([category, data]) => {
      response.categories[category] = {
        count: data.count,
        size: data.size,
        sizeFormatted: formatBytes(data.size),
        percentage: totalSize > 0 ? ((data.size / totalSize) * 100).toFixed(2) : 0,
        topExtensions: data.extensions.sort((a, b) => b.size - a.size).slice(0, 5).map(e => ({
          ext: e.ext,
          count: e.count,
          size: e.size,
          sizeFormatted: formatBytes(e.size)
        }))
      };
    });
    
    res.json(response);
  } catch (err) {
    console.error('Error getting file type breakdown:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get all photos with optional search and filters
app.get('/api/photos', requireAuth, requirePhotoPermission, async (req, res) => {
  try {
    const { search, filter } = req.query;
    
    let photos = await db.getPhotosWithMetadata();
    
    // Filter out photos with future dates
    const now = new Date();
    photos = photos.filter(photo => {
      if (!photo.date_taken) return true; // Keep photos without dates
      const photoDate = new Date(photo.date_taken);
      return photoDate <= now;
    });
    
    
    // Apply search
    if (search) {
      const searchLower = search.toLowerCase();
      photos = photos.filter(photo => 
        photo.name.toLowerCase().includes(searchLower) ||
        (photo.camera_make && photo.camera_make.toLowerCase().includes(searchLower)) ||
        (photo.camera_model && photo.camera_model.toLowerCase().includes(searchLower)) ||
        (photo.path && photo.path.toLowerCase().includes(searchLower))
      );
    }
    
    // Apply filters
    if (filter === 'gps') {
      photos = photos.filter(photo => photo.latitude !== null);
    } else if (filter === 'portrait') {
      photos = photos.filter(photo => photo.height > photo.width);
    } else if (filter === 'landscape') {
      photos = photos.filter(photo => photo.width > photo.height);
    } else if (filter && ['jpg', 'jpeg', 'png', 'heic', 'gif'].includes(filter.toLowerCase())) {
      // Extension filter
      const ext = filter.toLowerCase();
      photos = photos.filter(photo => {
        const photoExt = photo.name.split('.').pop().toLowerCase();
        return photoExt === ext;
      });
    }
    
    // Calculate stats
    const totalSize = photos.reduce((sum, p) => sum + Number(p.size), 0);
    const uniqueCameras = new Set(photos.map(p => p.camera_make).filter(Boolean)).size;
    const withGPS = photos.filter(p => p.latitude !== null).length;
    
    res.json({
      photos,
      stats: {
        totalPhotos: photos.length,
        totalSize: formatBytes(totalSize),
        uniqueCameras,
        withGPS
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all music tracks with optional search and filters
app.get('/api/music', requireAuth, requireMusicPermission, async (req, res) => {
  try {
    const { search, filter } = req.query;
    
    let tracks = await db.getMusicWithMetadata();
    
    // Apply search
    if (search) {
      const searchLower = search.toLowerCase();
      tracks = tracks.filter(track => 
        (track.title && track.title.toLowerCase().includes(searchLower)) ||
        (track.name && track.name.toLowerCase().includes(searchLower)) ||
        (track.artist && track.artist.toLowerCase().includes(searchLower)) ||
        (track.album && track.album.toLowerCase().includes(searchLower)) ||
        (track.genre && track.genre.toLowerCase().includes(searchLower))
      );
    }
    
    // Apply filters
    if (filter === 'hq') {
      tracks = tracks.filter(track => track.bitrate >= 320000);
    }
    
    // Calculate stats
    const totalSize = tracks.reduce((sum, t) => sum + Number(t.size), 0);
    const totalDuration = tracks.reduce((sum, t) => sum + (Number(t.duration) || 0), 0);
    const uniqueAlbums = new Set(tracks.map(t => t.album).filter(Boolean)).size;
    const uniqueArtists = new Set(tracks.map(t => t.artist).filter(Boolean)).size;
    
    const hours = Math.floor(totalDuration / 3600);
    const mins = Math.floor((totalDuration % 3600) / 60);
    
    res.json({
      tracks,
      stats: {
        totalTracks: tracks.length,
        totalAlbums: uniqueAlbums,
        totalArtists: uniqueArtists,
        totalDuration: `${hours}h ${mins}m`,
        totalSize: formatBytes(totalSize)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all movies with optional search and filters
app.get('/api/movies', requireAuth, requireVideoPermission, async (req, res) => {
  try {
    const { search, filter } = req.query;
    
    let movies = await db.getVideosWithMetadata();
    
    // Apply search
    if (search) {
      const searchLower = search.toLowerCase();
      movies = movies.filter(movie => 
        (movie.title && movie.title.toLowerCase().includes(searchLower)) ||
        (movie.name && movie.name.toLowerCase().includes(searchLower)) ||
        (movie.genre && movie.genre.toLowerCase().includes(searchLower)) ||
        (movie.video_codec && movie.video_codec.toLowerCase().includes(searchLower)) ||
        (movie.description && movie.description.toLowerCase().includes(searchLower))
      );
    }
    
    // Apply filters
    if (filter === '4k') {
      movies = movies.filter(movie => movie.width >= 3840);
    } else if (filter === 'hd') {
      movies = movies.filter(movie => movie.width >= 1280 && movie.width < 3840);
    } else if (filter === 'long') {
      movies = movies.filter(movie => movie.duration > 7200); // > 2 hours
    }
    
    // Calculate stats
    const totalSize = movies.reduce((sum, m) => sum + Number(m.size), 0);
    const totalDuration = movies.reduce((sum, m) => sum + (Number(m.duration) || 0), 0);
    const hdCount = movies.filter(m => m.width >= 1280 && m.width < 3840).length;
    const fourKCount = movies.filter(m => m.width >= 3840).length;
    
    const hours = Math.floor(totalDuration / 3600);
    const mins = Math.floor((totalDuration % 3600) / 60);
    
    res.json({
      movies,
      stats: {
        totalMovies: movies.length,
        totalDuration: `${hours}h ${mins}m`,
        totalSize: formatBytes(totalSize),
        hdCount,
        fourKCount
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get artists
app.get('/api/music/artists', requireAuth, async (req, res) => {
  try {
    const tracks = await db.getMusicWithMetadata();
    const artistMap = {};
    
    tracks.forEach(track => {
      if (track.artist) {
        if (!artistMap[track.artist]) {
          artistMap[track.artist] = {
            name: track.artist,
            trackCount: 0,
            albums: new Set()
          };
        }
        artistMap[track.artist].trackCount++;
        if (track.album) {
          artistMap[track.artist].albums.add(track.album);
        }
      }
    });
    
    const artists = Object.values(artistMap).map(artist => ({
      name: artist.name,
      trackCount: artist.trackCount,
      albumCount: artist.albums.size
    }));
    
    res.json({ artists });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get albums
app.get('/api/music/albums', requireAuth, async (req, res) => {
  try {
    const tracks = await db.getMusicWithMetadata();
    const albumMap = {};
    
    tracks.forEach(track => {
      if (track.album) {
        if (!albumMap[track.album]) {
          albumMap[track.album] = {
            name: track.album,
            artist: track.album_artist || track.artist,
            year: track.year,
            tracks: [],
            totalDuration: 0
          };
        }
        albumMap[track.album].tracks.push(track);
        albumMap[track.album].totalDuration += Number(track.duration) || 0;
      }
    });
    
    const albums = Object.values(albumMap).map(album => ({
      name: album.name,
      artist: album.artist,
      year: album.year,
      trackCount: album.tracks.length,
      duration: album.totalDuration
    }));
    
    res.json({ albums });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get tracks by artist
app.get('/api/music/artist/:name', requireAuth, async (req, res) => {
  try {
    const artistName = decodeURIComponent(req.params.name);
    
    // Validate input
    if (!artistName || artistName.length > 512) {
      return res.status(400).json({ error: 'Invalid artist name' });
    }
    
    const tracks = await db.getMusicWithMetadata();
    const artistTracks = tracks.filter(t => t.artist === artistName);
    
    res.json({ tracks: artistTracks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get tracks by album
app.get('/api/music/album/:name', requireAuth, async (req, res) => {
  try {
    const albumName = decodeURIComponent(req.params.name);
    
    // Validate input
    if (!albumName || albumName.length > 512) {
      return res.status(400).json({ error: 'Invalid album name' });
    }
    
    const tracks = await db.getMusicWithMetadata();
    const albumTracks = tracks.filter(t => t.album === albumName);
    
    res.json({ tracks: albumTracks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Record play history
app.post('/api/history/play', requireAuth, async (req, res) => {
  try {
    const { fileId, playType } = req.body;
    const userId = req.user.id;
    const ip = req.ip || req.connection.remoteAddress;
    
    if (!fileId) {
      return res.status(400).json({ error: 'File ID is required' });
    }
    
    // Validate playType
    const validPlayTypes = ['click', 'queue', 'auto_next', 'random'];
    const type = validPlayTypes.includes(playType) ? playType : 'click';
    
    await authManager.recordPlayHistory(userId, fileId, ip, type);
    res.json({ success: true, message: 'Play history recorded' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Google OAuth authentication endpoint (alternative method for client-side auth)
app.post('/api/auth/google', strictLimiter, async (req, res) => {
  try {
    const { token } = req.body;
    
    if (!token) {
      return res.status(400).json({ error: 'Google token required' });
    }

    // Verify the Google token
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: GOOGLE_CLIENT_ID
    });
    
    const payload = ticket.getPayload();
    
    // Convert Google profile format to match passport profile format
    const profile = {
      id: payload.sub,
      displayName: payload.name,
      emails: payload.email ? [{ value: payload.email }] : [],
      photos: payload.picture ? [{ value: payload.picture }] : []
    };

    // Create or update user using authManager
    const user = await authManager.findOrCreateGoogleUser(profile);

    // Generate JWT token using authManager
    const result = authManager.generateTokenForUser(user);
    
    // Record login history
    const ip = req.ip || req.connection.remoteAddress;
    await authManager.recordLoginHistory(user.id, ip, 'google');

    res.json(result);
  } catch (err) {
    console.error('Google auth error:', err);
    res.status(401).json({ error: 'Invalid Google token' });
  }
});

// Music rating endpoints
app.post('/api/music/rating', requireAuth, async (req, res) => {
  try {
    const { fileId, rating } = req.body;
    
    if (!fileId || !rating) {
      return res.status(400).json({ error: 'fileId and rating are required' });
    }

    // Validate input
    const validFileId = parseInt(fileId);
    const validRating = parseInt(rating);
    
    if (isNaN(validFileId) || validFileId <= 0) {
      return res.status(400).json({ error: 'Invalid fileId' });
    }
    
    if (isNaN(validRating) || validRating < 1 || validRating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }
    
    const result = await db.setMusicRating(validFileId, validRating, req.user.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get user's play history
app.get('/api/history/play', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 100;
    
    const history = await authManager.getPlayHistory(userId, limit);
    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/music/rating/:fileId', requireAuth, async (req, res) => {
  try {
    const fileId = parseInt(req.params.fileId);
    if (isNaN(fileId) || fileId <= 0) {
      return res.status(400).json({ error: 'Invalid fileId' });
    }
    
    const rating = await db.getUserTrackRating(fileId, req.user.id);
    res.json(rating || { rating: 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/music/ratings', async (req, res) => {
  try {
    const ratings = await db.getAllMusicRatings();
    res.json(ratings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get user's login history
app.get('/api/history/login', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 50;
    
    const history = await authManager.getLoginHistory(userId, limit);
    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get user-specific ratings
app.get('/api/music/my-ratings', requireAuth, async (req, res) => {
  try {
    const ratings = await db.getUserRatings(req.user.id);
    res.json(ratings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Music play history endpoints
app.post('/api/music/play', requireAuth, async (req, res) => {
  try {
    const { fileId } = req.body;
    
    if (!fileId) {
      return res.status(400).json({ error: 'fileId is required' });
    }

    const validFileId = parseInt(fileId);
    if (isNaN(validFileId) || validFileId <= 0) {
      return res.status(400).json({ error: 'Invalid fileId' });
    }
    
    const result = await db.recordMusicPlay(validFileId, req.user.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/music/play-count/:fileId', async (req, res) => {
  try {
    const fileId = parseInt(req.params.fileId);
    const count = await db.getMusicPlayCount(fileId);
    res.json({ fileId, playCount: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/music/play-counts', async (req, res) => {
  try {
    const playCounts = await db.getAllMusicPlayCounts();
    res.json(playCounts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/music/play-history/:fileId', async (req, res) => {
  try {
    const fileId = parseInt(req.params.fileId);
    if (isNaN(fileId) || fileId <= 0) {
      return res.status(400).json({ error: 'Invalid fileId' });
    }
    
    const limit = parseInt(req.query.limit) || 10;
    if (isNaN(limit) || limit <= 0 || limit > 1000) {
      return res.status(400).json({ error: 'Invalid limit (must be 1-1000)' });
    }
    
    const history = await db.getMusicPlayHistory(fileId, limit);
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get user's own play history
app.get('/api/music/my-plays', requireAuth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    if (isNaN(limit) || limit <= 0 || limit > 1000) {
      return res.status(400).json({ error: 'Invalid limit (must be 1-1000)' });
    }
    
    const history = await db.getUserPlayHistory(req.user.id, limit);
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve dashboard as homepage
app.get('/', (req, res) => {
  const html = fs.readFileSync(join(__dirname, 'public', 'dashboard.html'), 'utf8');
  res.send(html);
});

// Serve old homepage as /about
app.get('/about', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SilverFileSystem Media Server</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 2rem;
        }
        
        .container {
            text-align: center;
            max-width: 800px;
        }
        
        h1 {
            font-size: 3rem;
            margin-bottom: 1rem;
        }
        
        p {
            font-size: 1.2rem;
            margin-bottom: 3rem;
            opacity: 0.9;
        }
        
        .links {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 2rem;
            margin-top: 3rem;
        }
        
        .link-card {
            background: rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(10px);
            padding: 2rem;
            border-radius: 16px;
            text-decoration: none;
            color: white;
            transition: transform 0.3s, background 0.3s;
            border: 2px solid rgba(255, 255, 255, 0.2);
        }
        
        .link-card:hover {
            transform: translateY(-5px);
            background: rgba(255, 255, 255, 0.2);
        }
        
        .link-icon {
            font-size: 3rem;
            margin-bottom: 1rem;
        }
        
        .link-title {
            font-size: 1.3rem;
            font-weight: 600;
            margin-bottom: 0.5rem;
        }
        
        .link-desc {
            font-size: 0.9rem;
            opacity: 0.8;
        }
        
        .api-section {
            margin-top: 4rem;
            padding: 2rem;
            background: rgba(0, 0, 0, 0.2);
            border-radius: 16px;
            text-align: left;
        }
        
        .api-section h2 {
            margin-bottom: 1rem;
        }
        
        .api-endpoint {
            background: rgba(0, 0, 0, 0.3);
            padding: 1rem;
            border-radius: 8px;
            margin-bottom: 1rem;
            font-family: 'Courier New', monospace;
        }
        
        .method {
            display: inline-block;
            padding: 0.25rem 0.5rem;
            background: #50c878;
            border-radius: 4px;
            font-weight: bold;
            margin-right: 0.5rem;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎬 SilverFileSystem Media Server</h1>
        <p>Browse and search your media library</p>
        
        <div class="links">
            <a href="/photos" class="link-card">
                <div class="link-icon">📷</div>
                <div class="link-title">Photo Library</div>
                <div class="link-desc">Browse your photo collection</div>
            </a>
            
            <a href="/music" class="link-card">
                <div class="link-icon">🎵</div>
                <div class="link-title">Music Player</div>
                <div class="link-desc">Listen to your music</div>
            </a>
            
            <a href="/movies" class="link-card">
                <div class="link-icon">🎬</div>
                <div class="link-title">Movie Player</div>
                <div class="link-desc">Watch your movies</div>
            </a>
        </div>
        
        <div class="api-section">
            <h2>🔌 API Endpoints</h2>
            <div class="api-endpoint">
                <span class="method">GET</span> /api/photos?search=&filter=
            </div>
            <div class="api-endpoint">
                <span class="method">GET</span> /api/music?search=&filter=
            </div>
            <div class="api-endpoint">
                <span class="method">GET</span> /api/movies?search=&filter=
            </div>
            <div class="api-endpoint">
                <span class="method">GET</span> /api/music/artists
            </div>
            <div class="api-endpoint">
                <span class="method">GET</span> /api/music/albums
            </div>
        </div>
    </div>
</body>
</html>
  `);
});

// Serve photo library page
app.get('/photos', (req, res) => {
  const html = fs.readFileSync(join(__dirname, 'public', 'photos.html'), 'utf8');
  res.send(html);
});

// Serve music player page
app.get('/music', (req, res) => {
  const html = fs.readFileSync(join(__dirname, 'public', 'music.html'), 'utf8');
  res.send(html);
});

// Serve movie player page
app.get('/movies', (req, res) => {
  const html = fs.readFileSync(join(__dirname, 'public', 'movies.html'), 'utf8');
  res.send(html);
});

// Serve CLI tools page
app.get('/cli-tools', (req, res) => {
  const html = fs.readFileSync(join(__dirname, 'public', 'cli-tools.html'), 'utf8');
  res.send(html);
});

// CLI execution endpoint (for demonstration - shows command info)
app.post('/api/cli/execute', strictLimiter, async (req, res) => {
  try {
    const { command, args } = req.body;
    
    // For security, we'll return a formatted response showing what would be executed
    // In a production environment, you would want to carefully validate and sanitize inputs
    // or run commands in a sandboxed environment
    
    let output = '';
    output += `Command: silverfs ${command}\n`;
    output += `\nArguments:\n`;
    
    for (const [key, value] of Object.entries(args)) {
      if (value) {
        output += `  ${key}: ${value}\n`;
      }
    }
    
    output += `\n${'='.repeat(60)}\n\n`;
    output += `⚠️  CLI Execution Information\n\n`;
    output += `This is a demonstration interface showing the CLI command structure.\n`;
    output += `To execute commands:\n\n`;
    
    switch(command) {
      case 'scan':
        output += `1. Open your terminal\n`;
        output += `2. Navigate to the SilverFileSystem directory\n`;
        output += `3. Run: node bin/cli.js scan "${args.path}" ${args.options}\n\n`;
        output += `Example output:\n`;
        output += `  ✓ Scanning directory...\n`;
        output += `  ✓ Found 1,234 files\n`;
        output += `  ✓ Total size: 5.2 GB\n`;
        if (args.options.includes('--db')) {
          output += `  ✓ Stored in database\n`;
        }
        if (args.options.includes('--extract-media')) {
          output += `  ✓ Extracted media metadata\n`;
        }
        break;
        
      case 'duplicates':
        output += `Run: node bin/cli.js duplicates "${args.path}"`;
        if (args.minSize && args.minSize !== '0') {
          output += ` -m ${args.minSize}`;
        }
        output += ` ${args.options}\n\n`;
        output += `Example output:\n`;
        output += `  ✓ Found 42 duplicate groups\n`;
        output += `  ✓ Total wasted space: 856 MB\n`;
        break;
        
      case 'find-duplicates-db':
        output += `Run: node bin/cli.js find-duplicates-db`;
        if (args.minSize && args.minSize !== '0') {
          output += ` -m ${args.minSize}`;
        }
        if (args.report) {
          output += ` --report ${args.report}`;
        }
        output += `\n\nExample output:\n`;
        output += `  ✓ Querying database...\n`;
        output += `  ✓ Found 42 duplicate groups from database\n`;
        if (args.report) {
          output += `  ✓ Generated report: ${args.report}\n`;
        }
        break;
        
      case 'generate-report':
        output += `Run: node bin/cli.js generate-report "${args.output}"`;
        if (args.minSize && args.minSize !== '0') {
          output += ` -m ${args.minSize}`;
        }
        output += `\n\nExample output:\n`;
        output += `  ✓ Generating HTML report...\n`;
        output += `  ✓ Report saved: ${args.output}\n`;
        output += `  ✓ Open in browser to view interactive report\n`;
        break;
        
      case 'empty-files':
        output += `Run: node bin/cli.js empty-files "${args.path}"\n\n`;
        output += `Example output:\n`;
        output += `  ✓ Found 15 empty files\n`;
        output += `  ✓ Listed all empty files with paths\n`;
        break;
        
      case 'large-files':
        output += `Run: node bin/cli.js large-files "${args.path}" -m ${args.minSize} -l ${args.limit}\n\n`;
        output += `Example output:\n`;
        output += `  ✓ Top ${args.limit} files larger than ${args.minSize} MB\n`;
        output += `  1. video.mp4 - 2.5 GB\n`;
        output += `  2. backup.zip - 1.8 GB\n`;
        output += `  3. database.sql - 950 MB\n`;
        break;
    }
    
    output += `\n${'='.repeat(60)}\n`;
    output += `\n💡 Tip: Use the actual CLI for real-time execution and progress updates.\n`;
    output += `📖 See README.md for complete documentation.\n`;
    
    res.json({
      success: true,
      command: command,
      args: args,
      output: output
    });
    
  } catch (err) {
    console.error('CLI API error:', err);
    res.status(500).json({ 
      error: 'Failed to process command',
      message: err.message 
    });
  }
});

// ==================== START SERVER ====================

const PORT = process.env.PORT || 4000;

async function startServer() {
  try {
    console.log('🚀 Starting SilverFileSystem Media Server...\n');
    
    // Initialize database
    await initDatabase();
    
    // Create public directory if it doesn't exist
    const publicDir = join(__dirname, 'public');
    if (!fs.existsSync(publicDir)) {
      fs.mkdirSync(publicDir, { recursive: true });
      console.log('✓ Created public directory');
    }
    
    // Start server
    app.listen(PORT, () => {
      console.log(`\n✅ Server running on http://localhost:${PORT}`);
      console.log(`\n📷 Photo Library: http://localhost:${PORT}/photos`);
      console.log(`🎵 Music Player: http://localhost:${PORT}/music`);
      console.log(`🎬 Movie Player: http://localhost:${PORT}/movies`);
      console.log(`\n🔌 API Endpoints: http://localhost:${PORT}/about`);
      console.log(`📖 See SERVER_GUIDE.md for full API documentation\n`);
    });
  } catch (err) {
    console.error('❌ Failed to start server:', err.message);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n\n🛑 Shutting down server...');
  if (db) {
    await db.close();
  }
  process.exit(0);
});

startServer();
