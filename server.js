#!/usr/bin/env node

import express from 'express';
import cors from 'cors';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import session from 'express-session';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import morgan from 'morgan';
import { DatabaseManager } from './lib/database.js';
import { AuthManager, authMiddleware, adminMiddleware, requirePhotoPermission, requireMusicPermission, requireVideoPermission, clearPermissionsCache } from './lib/auth.js';
import { loadConfig } from './lib/utils.js';
import { isDriveRootAccessibleAsync, partitionByDriveOnline, shouldSkipMissingDeletion } from './lib/drive-online.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import heicConvert from 'heic-convert';
import ffmpegPath from 'ffmpeg-static';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
const execFileAsync = promisify(execFile);

const LOG_FILE = join(dirname(fileURLToPath(import.meta.url)), 'server.log');
const ERR_LOG_FILE = join(dirname(fileURLToPath(import.meta.url)), 'server_err.log');
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
const errLogStream = fs.createWriteStream(ERR_LOG_FILE, { flags: 'a' });

function logToFile(stream, level, args) {
  const ts = new Date().toISOString();
  const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  stream.write(`[${ts}] [${level}] ${msg}\n`);
}

const origLog = console.log;
const origError = console.error;
const origWarn = console.warn;
console.log = (...args) => { origLog(...args); logToFile(logStream, 'LOG', args); };
console.error = (...args) => { origError(...args); logToFile(errLogStream, 'ERROR', args); logToFile(logStream, 'ERROR', args); };
console.warn = (...args) => { origWarn(...args); logToFile(errLogStream, 'WARN', args); logToFile(logStream, 'WARN', args); };

process.on('uncaughtException', (err) => { origError('Uncaught Exception:', err); logToFile(errLogStream, 'UNCAUGHT', [err.stack || err.message]); process.exit(1); });
process.on('unhandledRejection', (reason) => { origError('Unhandled Rejection:', reason); logToFile(errLogStream, 'UNHANDLED', [String(reason)]); });

function computeQuickHash(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const size = stat.size;
    const fd = fs.openSync(filePath, 'r');
    const bufSize = Math.min(65536, size);
    const head = Buffer.alloc(bufSize);
    const tail = Buffer.alloc(bufSize);
    fs.readSync(fd, head, 0, bufSize, 0);
    if (size > bufSize) {
      fs.readSync(fd, tail, 0, bufSize, size - bufSize);
    }
    fs.closeSync(fd);
    const hash = crypto.createHash('md5').update(head).update(tail).update(String(size)).digest('hex');
    return { hash, size };
  } catch (err) {
    return null;
  }
}

async function fileExists(filePath, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    fs.access(filePath, fs.constants.F_OK, (err) => {
      clearTimeout(timer);
      resolve(!err);
    });
  });
}

async function getFileHashWithTimeout(db, fileId, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    getFileHash(db, fileId).then(result => {
      clearTimeout(timer);
      resolve(result);
    }).catch(() => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

async function getFileHash(db, fileId) {
  const info = await db.computeQuickHash(fileId);
  if (info && info.hash) return info;
  if (info && info.path) {
    const computed = computeQuickHash(info.path);
    if (computed) {
      db.connection.execute('UPDATE scanned_files SET quick_hash = ? WHERE id = ? AND quick_hash IS NULL', [computed.hash, fileId]).catch(() => {});
      return computed;
    }
  }
  return null;
}

function getVideoDuration(filePath) {
  return new Promise((resolve) => {
    let stderr = '';
    const p = spawn(ffmpegPath, ['-i', filePath, '-f', 'null', '-']);
    const timer = setTimeout(() => { try { p.kill(); } catch (_) {} resolve(0); }, 8000);
    p.stderr.on('data', d => { stderr += d.toString(); });
    p.on('close', () => {
      clearTimeout(timer);
      const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
      if (match) resolve(parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseFloat(match[3]));
      else resolve(0);
    });
    p.on('error', () => { clearTimeout(timer); resolve(0); });
  });
}

function ffmpegExtractFrame(filePath, seekTime, outputPath, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const h = String(Math.floor(seekTime / 3600)).padStart(2, '0');
    const m = String(Math.floor((seekTime % 3600) / 60)).padStart(2, '0');
    const s = (seekTime % 60).toFixed(2).padStart(5, '0');
    const ts = `${h}:${m}:${s}`;

    const p = spawn(ffmpegPath, [
      '-y', '-i', filePath,
      '-ss', ts,
      '-vframes', '1',
      '-vf', 'scale=320:-1',
      '-q:v', '5',
      outputPath
    ]);

    const timer = setTimeout(() => {
      try { p.kill('SIGKILL'); } catch (_) {}
      resolve(false);
    }, timeoutMs);

    p.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 && fs.existsSync(outputPath));
    });

    p.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const config = loadConfig();

// Trust proxy for proper HTTPS detection behind reverse proxies
app.set('trust proxy', 1);

// Enable access logging
app.use(morgan('combined', { stream: fs.createWriteStream('access.log', { flags: 'a' }) }));

// Rate limiting middleware
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10000, // Limit each IP to 100 requests per windowMs
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
  max: 5000, // Higher limit for media files
  message: 'Too many media requests from this IP, please try again later.'
});

// Very strict rate limiting for authentication endpoints to prevent brute force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Allow many login attempts for testing/development
  message: 'Too many login attempts from this IP, please try again later.',
  skipSuccessfulRequests: false // Count both successful and failed attempts
});

// Middleware
app.use(compression());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:4000',
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());

// Disable caching for HTML files to ensure latest version is always served
app.use((req, res, next) => {
    if (req.url.endsWith('.html') || req.url === '/' || !req.url.includes('.')) {
        res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
    }
    next();
});

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

// Wrapper functions that will use the initialized middleware
const requireAuthWrapper = (req, res, next) => {
  if (!requireAuth) {
    return res.status(500).json({ error: 'Authentication not initialized' });
  }
  return requireAuth(req, res, next);
};

const requireAdminWrapper = (req, res, next) => {
  if (!requireAdmin) {
    return res.status(500).json({ error: 'Authentication not initialized' });
  }
  return requireAdmin(req, res, next);
};

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
  await db.updateSchema();

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
  const callbackURL = process.env.GOOGLE_CALLBACK_URL || 'http://localhost:4001/api/auth/google/callback';

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

  // Helper: get file path from scanned_files using folder_id_int + name
  async function getFilePath(fileId) {
    const [rows] = await db.connection.query(
      'SELECT sf.name, ft.folder_id as folder_path FROM scanned_files sf LEFT JOIN folder_tree ft ON sf.folder_id_int = ft.id WHERE sf.id = ?',
      [fileId]
    );
    console.log(`[DEBUG] getFilePath(${fileId}): rows=${JSON.stringify(rows)}`);
    if (rows.length === 0 || !rows[0].folder_path) return null;
    const filePath = rows[0].folder_path + '\\' + rows[0].name;
    console.log(`[DEBUG] getFilePath(${fileId}) → "${filePath}"`);
    return filePath;
  }

  // Serve image files (after database is initialized)
  app.get('/images/:id', requireAuth, requirePhotoPermission, mediaLimiter, async (req, res) => {
    try {
      const fileId = req.params.id;

      const filePath = await getFilePath(fileId);
      console.log(`[DEBUG] /images/${fileId} → filePath: "${filePath}"`);
      if (!filePath) {
        return res.status(404).json({ error: 'Image not found' });
      }
      const ext = path.extname(filePath).toLowerCase();
      const exists = await fileExists(filePath);
      console.log(`[DEBUG] fileExists: ${exists}, ext: ${ext}`);
      if (!exists) {
        return res.status(404).json({ error: 'File not found on disk' });
      }

      // Convert HEIC to JPEG for browser compatibility
      if (['.heic', '.heif'].includes(ext)) {
        try {
          const inputBuffer = fs.readFileSync(filePath);
          const jpegBuffer = await heicConvert({ buffer: inputBuffer, format: 'JPEG', quality: 0.9 });
          res.setHeader('Content-Type', 'image/jpeg');
          res.setHeader('Cache-Control', 'public, max-age=86400');
          return res.send(jpegBuffer);
        } catch (err) {
          console.warn(`HEIC conversion failed for ${filePath}: ${err.message}`);
          return res.status(415).json({ error: 'Cannot convert this image format' });
        }
      }

      // Set appropriate content type based on file extension
      const contentTypes = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.bmp': 'image/bmp',
        '.tiff': 'image/tiff',
        '.webp': 'image/webp'
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

  // Serve thumbnail images (resized via sharp)
  const thumbnailCache = new Map();
  const THUMBNAIL_MAX_SIZE = 400;
  const THUMBNAIL_CACHE_MAX = 500;

  async function serveResizedImage(filePath, maxSize, quality = 80) {
    const ext = path.extname(filePath).toLowerCase();
    const heicFormats = ['.heic', '.heif'];
    const sharpFormats = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.tif', '.bmp'];

    if (heicFormats.includes(ext)) {
      try {
        const inputBuffer = fs.readFileSync(filePath);
        const jpegBuffer = await heicConvert({ buffer: inputBuffer, format: 'JPEG', quality: quality / 100 });
        const resized = await sharp(jpegBuffer)
          .resize({ width: maxSize, height: maxSize, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality })
          .toBuffer();
        return { buffer: resized, contentType: 'image/jpeg' };
      } catch (heicErr) {
        console.warn(`HEIC conversion failed for ${filePath}: ${heicErr.message}`);
        return null;
      }
    }

    if (sharpFormats.includes(ext)) {
      const buffer = await sharp(filePath)
        .resize({ width: maxSize, height: maxSize, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer();
      return { buffer, contentType: 'image/jpeg' };
    }

    return null;
  }

  app.get('/images/:id/thumb', requireAuth, requirePhotoPermission, mediaLimiter, async (req, res) => {
    try {
      const fileId = req.params.id;

      // Check in-memory cache first
      const cached = thumbnailCache.get(fileId);
      if (cached) {
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.send(cached);
      }

      // Check DB cache (with timeout)
      const fileInfo = await getFileHashWithTimeout(db, fileId, 3000);
      if (fileInfo && fileInfo.hash) {
        const dbCached = await db.getThumbnail(fileInfo.hash, fileInfo.size, 'image');
        if (dbCached) {
          const buf = Buffer.isBuffer(dbCached.thumb_data) ? dbCached.thumb_data : Buffer.from(dbCached.thumb_data);
          if (thumbnailCache.size >= THUMBNAIL_CACHE_MAX) {
            const firstKey = thumbnailCache.keys().next().value;
            thumbnailCache.delete(firstKey);
          }
          thumbnailCache.set(fileId, buf);
          res.setHeader('Content-Type', dbCached.content_type || 'image/jpeg');
          res.setHeader('Cache-Control', 'public, max-age=86400');
          return res.send(buf);
        }
      }

      // Get file path using helper
      const filePath = await getFilePath(fileId);
      if (!filePath) {
        return res.status(404).json({ error: 'Image not found' });
      }

      if (!(await fileExists(filePath))) {
        return res.status(404).json({ error: 'File not found on disk' });
      }

      const result = await serveResizedImage(filePath, THUMBNAIL_MAX_SIZE, 75);

      if (!result) {
        return res.status(415).json({ error: 'Image format not supported for thumbnails' });
      }

      // Cache the result
      if (thumbnailCache.size >= THUMBNAIL_CACHE_MAX) {
        const firstKey = thumbnailCache.keys().next().value;
        thumbnailCache.delete(firstKey);
      }
      thumbnailCache.set(fileId, result.buffer);

      // Save to DB cache (async, don't block response)
      if (fileInfo && fileInfo.hash) {
        db.saveThumbnail(fileInfo.hash, fileInfo.size, 'image', result.buffer, result.contentType || 'image/jpeg').catch(() => {});
      }

      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(result.buffer);

    } catch (err) {
      console.error('Error serving thumbnail:', err.message);
      res.status(500).json({ error: 'Error serving thumbnail' });
    }
  });

  // Serve audio files
  app.get('/audio/:id', requireAuth, requireMusicPermission, mediaLimiter, async (req, res) => {
    try {
      const fileId = req.params.id;

      const filePath = await getFilePath(fileId);
      if (!filePath) {
        return res.status(404).json({ error: 'Audio not found' });
      }

      if (!(await fileExists(filePath))) {
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

      const filePath = await getFilePath(fileId);
      if (!filePath) {
        return res.status(404).json({ error: 'Video not found' });
      }

      if (!(await fileExists(filePath))) {
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

  // Serve video thumbnails (extract frame via ffmpeg)
  const videoThumbnailCache = new Map();
  const VIDEO_THUMB_CACHE_MAX = 500;

  function ffmpegExtractFrameToBuffer(filePath, seekSec, width, timeoutMs = 12000) {
    return new Promise((resolve) => {
      const tmpPath = path.join(__dirname, `tmp-frame-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
      const ts = String(Math.floor(seekSec / 3600)).padStart(2, '0') + ':' +
                 String(Math.floor((seekSec % 3600) / 60)).padStart(2, '0') + ':' +
                 (seekSec % 60).toFixed(2).padStart(5, '0');

      const p = spawn(ffmpegPath, [
        '-y', '-i', filePath,
        '-ss', ts,
        '-vframes', '1',
        '-vf', `scale=${width}:-1`,
        '-q:v', '3',
        tmpPath
      ]);

      const timer = setTimeout(() => {
        try { p.kill('SIGKILL'); } catch (_) {}
        try { fs.unlinkSync(tmpPath); } catch (_) {}
        resolve(null);
      }, timeoutMs);

      p.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 && fs.existsSync(tmpPath)) {
          try {
            const buf = fs.readFileSync(tmpPath);
            fs.unlinkSync(tmpPath);
            resolve(buf);
          } catch (_) { resolve(null); }
        } else {
          try { fs.unlinkSync(tmpPath); } catch (_) {}
          resolve(null);
        }
      });

      p.on('error', () => { clearTimeout(timer); resolve(null); });
    });
  }

  app.get('/video/:id/thumb', requireAuth, requireVideoPermission, mediaLimiter, async (req, res) => {
    try {
      const fileId = req.params.id;

      const cached = videoThumbnailCache.get(fileId);
      if (cached) {
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.send(cached);
      }

      // Check DB cache (with timeout)
      const fileInfo = await getFileHashWithTimeout(db, fileId, 3000);
      if (fileInfo && fileInfo.hash) {
        const dbCached = await db.getThumbnail(fileInfo.hash, fileInfo.size, 'video');
        if (dbCached) {
          const buf = Buffer.isBuffer(dbCached.thumb_data) ? dbCached.thumb_data : Buffer.from(dbCached.thumb_data);
          if (videoThumbnailCache.size >= VIDEO_THUMB_CACHE_MAX) {
            const firstKey = videoThumbnailCache.keys().next().value;
            videoThumbnailCache.delete(firstKey);
          }
          videoThumbnailCache.set(fileId, buf);
          res.setHeader('Content-Type', dbCached.content_type || 'image/jpeg');
          res.setHeader('Cache-Control', 'public, max-age=86400');
          return res.send(buf);
        }
      }

      const filePath = await getFilePath(fileId);
      if (!filePath) {
        return res.status(404).json({ error: 'Video not found' });
      }

      if (!(await fileExists(filePath))) {
        return res.status(404).json({ error: 'File not found on disk' });
      }

      const duration = await getVideoDuration(filePath);
      const seekSec = duration > 2 ? Math.min(1, duration * 0.1) : 0.5;
      const buffer = await ffmpegExtractFrameToBuffer(filePath, seekSec, 400);

      if (!buffer) {
        return res.status(415).json({ error: 'Cannot generate video thumbnail' });
      }

      if (videoThumbnailCache.size >= VIDEO_THUMB_CACHE_MAX) {
        const firstKey = videoThumbnailCache.keys().next().value;
        videoThumbnailCache.delete(firstKey);
      }
      videoThumbnailCache.set(fileId, buffer);

      // Save to DB cache (async)
      if (fileInfo && fileInfo.hash) {
        db.saveThumbnail(fileInfo.hash, fileInfo.size, 'video', buffer, 'image/jpeg').catch(() => {});
      }

      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(buffer);

    } catch (err) {
      console.error('Error serving video thumbnail:', err.message);
      res.status(500).json({ error: 'Error serving video thumbnail' });
    }
  });

  // Serve video preview GIF (3 frames at 20%, 50%, 80% of duration)
  const videoGifCache = new Map();
  const VIDEO_GIF_CACHE_MAX = 300;
  let gifQueueActive = 0;
  const GIF_MAX_CONCURRENT = 2;

  function gifQueue(fn) {
    return new Promise((resolve, reject) => {
      const run = async () => {
        gifQueueActive++;
        try { resolve(await fn()); }
        catch (e) { reject(e); }
        finally {
          gifQueueActive--;
          if (gifQueuePending.length > 0) gifQueuePending.shift()();
        }
      };
      if (gifQueueActive < GIF_MAX_CONCURRENT) run();
      else gifQueuePending.push(run);
    });
  }
  const gifQueuePending = [];

  app.get('/video/:id/preview', requireAuth, requireVideoPermission, mediaLimiter, async (req, res) => {
    try {
      const fileId = req.params.id;

      const cached = videoGifCache.get(fileId);
      if (cached) {
        res.setHeader('Content-Type', 'image/gif');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.send(cached);
      }

      const filePath = await getFilePath(fileId);
      if (!filePath) {
        return res.status(404).json({ error: 'Video not found' });
      }

      if (!(await fileExists(filePath))) {
        return res.status(404).json({ error: 'File not found on disk' });
      }

      const tmpGif = path.join(__dirname, `tmp-preview-${fileId}-${Date.now()}.gif`);

      try {
        const gifBuffer = await gifQueue(() => generateVideoGif(filePath, tmpGif, fileId));

        if (!gifBuffer) {
          return res.status(415).json({ error: 'Cannot generate video preview' });
        }

        if (videoGifCache.size >= VIDEO_GIF_CACHE_MAX) {
          const firstKey = videoGifCache.keys().next().value;
          videoGifCache.delete(firstKey);
        }
        videoGifCache.set(fileId, gifBuffer);

        res.setHeader('Content-Type', 'image/gif');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(gifBuffer);

      } catch (ffErr) {
        console.warn(`ffmpeg preview failed for ${filePath}: ${ffErr.message}`);
        return res.status(415).json({ error: 'Cannot generate video preview' });
      } finally {
        try { fs.unlinkSync(tmpGif); } catch (_) {}
      }

    } catch (err) {
      console.error('Error serving video preview:', err.message);
      res.status(500).json({ error: 'Error serving video preview' });
    }
  });

  async function generateVideoGif(filePath, tmpGif, fileId) {
    const duration = await getVideoDuration(filePath);
    if (duration <= 0) return null;

    const positions = [0.2, 0.5, 0.8];
    const seekTimes = positions.map(p => Math.max(0.5, duration * p));

    // Single ffmpeg call: extract 3 frames and concat into GIF
    const filterInputs = seekTimes.map((t, i) => {
      const endTime = Math.min(t + 0.5, duration);
      return `[0:v]trim=start=${t}:end=${endTime},setpts=PTS-STARTPTS,scale=320:-1:flags=lanczos,setsar=1,fps=2[v${i}]`;
    });

    const concatInputs = seekTimes.map((_, i) => `[v${i}]`).join('');
    const filterComplex = filterInputs.join(';') + `;${concatInputs}concat=n=3:v=1:a=0[out]`;

    return new Promise((resolve) => {
      const p = spawn(ffmpegPath, [
        '-y', '-i', filePath,
        '-filter_complex', filterComplex,
        '-map', '[out]',
        '-loop', '0',
        tmpGif
      ]);

      const timer = setTimeout(() => {
        try { p.kill('SIGKILL'); } catch (_) {}
        resolve(null);
      }, 30000);

      p.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 && fs.existsSync(tmpGif)) {
          try {
            const buf = fs.readFileSync(tmpGif);
            resolve(buf);
          } catch (_) { resolve(null); }
        } else {
          resolve(null);
        }
      });

      p.on('error', () => { clearTimeout(timer); resolve(null); });
    });
  }

  // Serve duplicates page
app.get('/duplicates', (req, res) => {
  const html = fs.readFileSync(join(__dirname, 'public', 'duplicates.html'), 'utf8');
  res.send(html);
});

// ==================== ADMIN ROUTES ====================

  // Rebuild folder tree
  app.get('/api/rebuild-folder-tree', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { folderId } = req.query;
      if (folderId) {
        // Quick rebuild: just refresh stats for this folder + ancestors
        await db.refreshFolderStats(parseInt(folderId));
        res.json({ success: true, message: 'Folder stats refreshed' });
      } else {
        await db.rebuildFolderTree();
        res.json({ success: true, message: 'Folder tree rebuilt' });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

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
      clearPermissionsCache(userId);
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
      clearPermissionsCache(userId);
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
      clearPermissionsCache(userId);
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

// Folder tree API - uses folder_tree table for fast indexed queries
app.get('/api/folder-tree', requireAuthWrapper, async (req, res) => {
  try {
    const { path: reqPath, id: reqId } = req.query;

    if (!reqPath && !reqId) {
      // Return root drives — folders whose parent is a root drive (depth=2, parent is the drive letter at depth=1)
      const [drives] = await db.connection.query(`
        SELECT p.id, p.folder_id as drive, p.remark, p.hidden,
               SUM(c.file_count) as file_count, SUM(c.total_size) as total_size,
               SUM(c.recursive_count) as recursive_count, SUM(c.recursive_size) as recursive_size
        FROM folder_tree c
        INNER JOIN folder_tree p ON c.parent_id = p.id
        WHERE c.depth = 2
        GROUP BY p.id, p.folder_id, p.remark, p.hidden
        ORDER BY recursive_size DESC
      `);
      return res.json({
        path: '',
        children: drives.map(r => ({
          id: r.id,
          name: r.drive,
          path: r.drive,
          isFolder: true,
          fileCount: parseInt(r.file_count),
          totalSize: parseInt(r.total_size),
          totalSizeFormatted: formatBytes(parseInt(r.total_size)),
          recursiveCount: parseInt(r.recursive_count),
          recursiveSize: parseInt(r.recursive_size),
          recursiveSizeFormatted: formatBytes(parseInt(r.recursive_size)),
          hidden: r.hidden === 1,
          remark: r.remark || null
        }))
      });
    }

    let normalizedPath;
    let folderId;

    if (reqId) {
      // Lookup by ID
      const [row] = await db.connection.query('SELECT folder_id FROM folder_tree WHERE id = ?', [parseInt(reqId)]);
      if (row.length === 0) {
        return res.status(404).json({ error: 'Folder not found' });
      }
      normalizedPath = row[0].folder_id;
      folderId = parseInt(reqId);
    } else {
      normalizedPath = reqPath.replace(/\//g, '\\');
      // Strip trailing backslash for folder_tree lookup
      if (normalizedPath.endsWith('\\') && normalizedPath.length > 1) {
        normalizedPath = normalizedPath.slice(0, -1);
      }
      // Resolve path to folder_tree id
      const [row] = await db.connection.query('SELECT id FROM folder_tree WHERE folder_id = ?', [normalizedPath]);
      folderId = row.length > 0 ? row[0].id : null;
    }

    // Get child folders — only immediate children using indexed parent_id
    if (!folderId) {
      return res.json({ path: normalizedPath, info: null, children: [] });
    }

    const [currentInfo] = await db.connection.query(
      'SELECT file_count, total_size, recursive_count, recursive_size, remark, hidden FROM folder_tree WHERE id = ?',
      [folderId]
    );

    const showHidden = req.query.showHidden === '1';
    const hiddenClause = showHidden ? '' : 'AND hidden = 0';
    const foldersOnly = req.query.foldersOnly === '1';
    const sortKey = (req.query.sort === 'recursive_size') ? 'recursive_size' : 'total_size';

    const [children] = await db.connection.query(`
      SELECT id, folder_id, folder_name, file_count, total_size, recursive_count, recursive_size, hidden, remark, related_folder_id, created_at
      FROM folder_tree
      WHERE parent_id = ? ${hiddenClause}
      ORDER BY ${sortKey} DESC
      LIMIT 200
    `, [folderId]);

    // Get direct files (files in this exact folder from scanned_files)
    let files = [];
    if (!foldersOnly) {
      const [fileRows] = await db.connection.query(`
        SELECT name, size, extension, mtime, ctime
        FROM scanned_files
        WHERE folder_id_int = ?
        ORDER BY size DESC
        LIMIT 50
      `, [folderId]);
      files = fileRows;
    }

    res.json({
      id: folderId,
      path: normalizedPath,
      info: currentInfo.length > 0 ? {
        fileCount: parseInt(currentInfo[0].file_count),
        totalSize: parseInt(currentInfo[0].total_size),
        totalSizeFormatted: formatBytes(parseInt(currentInfo[0].total_size)),
        recursiveCount: parseInt(currentInfo[0].recursive_count),
        recursiveSize: parseInt(currentInfo[0].recursive_size),
        recursiveSizeFormatted: formatBytes(parseInt(currentInfo[0].recursive_size)),
        remark: currentInfo[0].remark || null,
        hidden: currentInfo[0].hidden === 1
      } : null,
      children: [
        ...children.map(r => ({
          id: r.id,
          name: r.folder_name,
          path: r.folder_id,
          isFolder: true,
          fileCount: parseInt(r.file_count),
          totalSize: parseInt(r.total_size),
          totalSizeFormatted: formatBytes(parseInt(r.total_size)),
          recursiveCount: parseInt(r.recursive_count),
          recursiveSize: parseInt(r.recursive_size),
          recursiveSizeFormatted: formatBytes(parseInt(r.recursive_size)),
          hidden: r.hidden === 1,
          remark: r.remark || null,
          relatedFolderId: r.related_folder_id || null,
          createdAt: r.created_at || null,
          lastModified: null
        })),
        ...files.map(r => ({
          name: r.name,
          path: normalizedPath + '\\' + r.name,
          isFolder: false,
          size: parseInt(r.size),
          sizeFormatted: formatBytes(parseInt(r.size)),
          extension: r.extension,
          mtime: r.mtime,
          ctime: r.ctime,
          lastModified: r.mtime || null,
          createdAt: r.ctime || null
        }))
      ]
    });
  } catch (err) {
    console.error('Folder tree error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// Top files by size for a folder (usage-chart leaf view)
app.get('/api/folder-tree/:id/top-files', requireAuthWrapper, async (req, res) => {
  try {
    const folderId = parseInt(req.params.id, 10);
    if (!Number.isFinite(folderId) || folderId <= 0) {
      return res.status(400).json({ error: 'Invalid folder id' });
    }
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 30;
    if (limit > 100) limit = 100;

    const [folderRows] = await db.connection.query(
      'SELECT id, folder_id FROM folder_tree WHERE id = ?',
      [folderId]
    );
    if (!folderRows.length) {
      return res.status(404).json({ error: 'Folder not found' });
    }
    const folderPath = folderRows[0].folder_id;

    const [fileRows] = await db.connection.query(
      `SELECT id, name, size, extension, mtime, ctime
       FROM scanned_files
       WHERE folder_id_int = ?
       ORDER BY size DESC
       LIMIT ?`,
      [folderId, limit]
    );

    res.json({
      folderId,
      path: folderPath,
      limit,
      files: fileRows.map(r => ({
        id: r.id,
        name: r.name,
        size: parseInt(r.size, 10) || 0,
        sizeFormatted: formatBytes(parseInt(r.size, 10) || 0),
        extension: r.extension || null,
        path: folderPath + '\\' + r.name,
        lastModified: r.mtime || null,
        createdAt: r.ctime || null
      }))
    });
  } catch (err) {
    console.error('Top files error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Delete file record from database by path


  // Update folder hidden/remark
  app.put('/api/folder-tree/:id', requireAuthWrapper, async (req, res) => {
    try {
      const { id } = req.params;
      const { hidden, remark, related_folder_id } = req.body;
      
      const updates = [];
      const values = [];
      
      if (hidden !== undefined) {
        updates.push('hidden = ?');
        values.push(hidden ? 1 : 0);
      }
      if (remark !== undefined) {
        updates.push('remark = ?');
        values.push(remark || null);
      }
      if (related_folder_id !== undefined) {
        updates.push('related_folder_id = ?');
        values.push(related_folder_id || null);
      }
      
      if (updates.length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }
      
      values.push(id);
      await db.connection.query(
        `UPDATE folder_tree SET ${updates.join(', ')} WHERE id = ?`,
        values
      );
      
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

// Check for deleted files in a folder and remove from DB (supports recursive)
app.post('/api/folder-tree/check-deleted', requireAuthWrapper, async (req, res) => {
  try {
    const { folderId, remove, recursive } = req.body;
    if (!folderId) return res.status(400).json({ error: 'folderId required' });

    const [folderRow] = await db.connection.query('SELECT folder_id FROM folder_tree WHERE id = ?', [folderId]);
    if (folderRow.length === 0) return res.status(404).json({ error: 'Folder not found' });

    let folderIds = [folderId];
    if (recursive) {
      const [children] = await db.connection.query('SELECT id FROM folder_tree WHERE parent_id = ?', [folderId]);
      const queue = children.map(c => c.id);
      while (queue.length > 0) {
        const current = queue.shift();
        folderIds.push(current);
        const [sub] = await db.connection.query('SELECT id FROM folder_tree WHERE parent_id = ?', [current]);
        for (const s of sub) queue.push(s.id);
      }
    }

    const placeholders = folderIds.map(() => '?').join(',');
    const [files] = await db.connection.query(
      `SELECT sf.id, sf.name, ft.folder_id as folder_path
       FROM scanned_files sf
       JOIN folder_tree ft ON ft.id = sf.folder_id_int
       WHERE sf.folder_id_int IN (${placeholders})`,
      folderIds
    );

    if (files.length === 0) return res.json({ total: 0, missing: 0, removed: 0, files: [], foldersChecked: folderIds.length });

    // Attach full path; skip volumes whose drive root is offline (e.g. mapped P: NAS).
    const withPaths = files.map(f => ({ ...f, path: f.folder_path + '\\' + f.name }));
    const { online: reachableFiles, skippedOffline } = await partitionByDriveOnline(withPaths, {
      log: console.warn,
      timeoutMs: 3000
    });
    const skippedOfflineCount = skippedOffline.length;

    const BATCH = 100;
    const missing = [];

    for (let i = 0; i < reachableFiles.length; i += BATCH) {
      const batch = reachableFiles.slice(i, i + BATCH);
      const checks = batch.map(f => {
        const fullPath = f.path;
        return new Promise(resolve => {
          const timer = setTimeout(() => resolve({ ...f, exists: false, path: fullPath }), 2000);
          fs.access(fullPath, fs.constants.F_OK, err => {
            clearTimeout(timer);
            resolve({ ...f, exists: !err, path: fullPath });
          });
        });
      });
      const results = await Promise.all(checks);
      for (const r of results) {
        if (!r.exists) missing.push(r);
      }
    }

    let removed = 0;
    let archived = 0;
    if (remove && missing.length > 0) {
      archived = await db.archiveDeletedFiles(missing.map(f => ({
        id: f.id, name: f.name, path: f.path, size: null, hash: null, extension: null
      })), 'check-deleted');
      const DEL_BATCH = 500;
      for (let i = 0; i < missing.length; i += DEL_BATCH) {
        const batch = missing.slice(i, i + DEL_BATCH);
        const ids = batch.map(f => f.id);
        const ph = ids.map(() => '?').join(',');
        await db.connection.query(`DELETE FROM scanned_files WHERE id IN (${ph})`, ids);
        removed += batch.length;
      }
      // Refresh folder stats for all checked folders
      for (const fid of folderIds) {
        await db.refreshFolderStats(fid);
      }
    }

    res.json({
      total: files.length,
      missing: missing.length,
      removed,
      archived,
      skippedOffline: typeof skippedOfflineCount === 'number' ? skippedOfflineCount : 0,
      foldersChecked: folderIds.length,
      files: missing.slice(0, 100).map(f => ({ id: f.id, name: f.name, path: f.path }))
    });
  } catch (err) {
    console.error('Check deleted error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Delete file record from database by path
// Rescan current folder files from disk into scanned_files.
// Body: { folderId, recursive?: boolean } — recursive=true walks the subtree (Reload).
// Default / Refresh one level = non-recursive (files + discover immediate child dirs).
async function rescanFolderOneLevel(folderId) {
  const fid = parseInt(folderId, 10);
  const [folderRow] = await db.connection.query(
    'SELECT id, folder_id, depth FROM folder_tree WHERE id = ?',
    [fid]
  );
  if (folderRow.length === 0) return { error: 'Folder not found', status: 404 };

  const folderPath = folderRow[0].folder_id;
  const folderDepth = parseInt(folderRow[0].depth, 10) || folderPath.split('\\').filter(Boolean).length;

  let entries;
  try {
    entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
  } catch (err) {
    return { error: `Cannot read folder: ${err.message}`, status: 400, path: folderPath };
  }

  const diskFiles = new Map();
  const diskDirs = [];
  const toSql = (d) => {
    if (!d) return null;
    const dt = d instanceof Date ? d : new Date(d);
    if (isNaN(dt.getTime())) return null;
    return dt.toISOString().slice(0, 19).replace('T', ' ');
  };
  for (const entry of entries) {
    try {
      if (entry.isDirectory()) {
        diskDirs.push(entry.name);
        continue;
      }
      if (!entry.isFile()) continue;
      const fullPath = path.join(folderPath, entry.name);
      const st = await fs.promises.stat(fullPath);
      const extMatch = entry.name.match(/\.([^.]+)$/);
      let extension = extMatch ? extMatch[1] : '';
      if (extension.length > 255) extension = extension.substring(0, 255);
      diskFiles.set(entry.name, {
        size: st.size,
        mtime: toSql(st.mtime),
        atime: toSql(st.atime),
        ctime: toSql(st.ctime),
        extension
      });
    } catch (_) {}
  }

  const [dbFiles] = await db.connection.query(
    'SELECT id, name, size, mtime FROM scanned_files WHERE folder_id_int = ?',
    [fid]
  );
  const dbByName = new Map(dbFiles.map(f => [f.name, f]));

  let added = 0, updated = 0, removed = 0, foldersAdded = 0;
  const missing = [];
  for (const row of dbFiles) {
    if (!diskFiles.has(row.name)) missing.push(row);
  }

  if (missing.length > 0) {
    // Defense in depth: if drive went offline after readdir, do not invent deletions.
    // Motivating case: mapped P: NAS. General: any X:\ whose root is unreachable.
    const driveOk = await isDriveRootAccessibleAsync(folderPath, 3000);
    if (!driveOk) {
      console.warn('[drive-online] Skipping tree-rescan deletions; drive offline for ' + folderPath);
    } else {
      try {
        await db.archiveDeletedFiles(missing.map(f => ({
          id: f.id, name: f.name, path: folderPath + '\\' + f.name, size: f.size, hash: null, extension: null
        })), 'tree-rescan');
      } catch (_) {}
      const DEL_BATCH = 500;
      for (let i = 0; i < missing.length; i += DEL_BATCH) {
        const batch = missing.slice(i, i + DEL_BATCH);
        const ids = batch.map(f => f.id);
        const ph = ids.map(() => '?').join(',');
        await db.connection.query(`DELETE FROM scanned_files WHERE id IN (${ph})`, ids);
        removed += batch.length;
      }
    }
  }

  for (const [name, meta] of diskFiles) {
    const existing = dbByName.get(name);
    if (!existing) {
      await db.connection.execute(
        `INSERT INTO scanned_files
         (name, size, hash, quick_hash, extension, mtime, atime, ctime, scan_id, folder_id_int)
         VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, NULL, ?)`,
        [name, meta.size, meta.extension, meta.mtime, meta.atime, meta.ctime, fid]
      );
      added++;
    } else {
      const oldMtime = existing.mtime ? new Date(existing.mtime).getTime() : null;
      const newMtime = meta.mtime ? new Date(meta.mtime + 'Z').getTime() : null;
      const sizeChanged = Number(existing.size) !== Number(meta.size);
      const mtimeChanged = oldMtime !== newMtime;
      if (sizeChanged || mtimeChanged) {
        await db.connection.execute(
          `UPDATE scanned_files SET size = ?, extension = ?, mtime = ?, atime = ?, ctime = ?
           WHERE id = ?`,
          [meta.size, meta.extension, meta.mtime, meta.atime, meta.ctime, existing.id]
        );
        updated++;
      }
    }
  }

  const [childFolders] = await db.connection.query(
    'SELECT folder_name FROM folder_tree WHERE parent_id = ?',
    [fid]
  );
  const existingChildNames = new Set(childFolders.map(c => c.folder_name));
  for (const dirName of diskDirs) {
    if (existingChildNames.has(dirName)) continue;
    const childPath = folderPath + '\\' + dirName;
    const childDepth = folderDepth + 1;
    try {
      const [ins] = await db.connection.execute(
        `INSERT IGNORE INTO folder_tree (folder_id, folder_name, file_count, total_size, recursive_count, recursive_size, depth, parent_id)
         VALUES (?, ?, 0, 0, 0, 0, ?, ?)`,
        [childPath, dirName, childDepth, fid]
      );
      if (ins.affectedRows > 0) foldersAdded++;
    } catch (_) {}
  }

  return {
    success: true,
    path: folderPath,
    folderId: fid,
    added,
    updated,
    removed,
    foldersAdded,
    diskFiles: diskFiles.size,
    diskDirs: diskDirs.length
  };
}

app.post('/api/folder-tree/rescan', requireAuthWrapper, async (req, res) => {
  try {
    const body = req.body || {};
    const { folderId } = body;
    if (!folderId) return res.status(400).json({ error: 'folderId required' });
    const fid = parseInt(folderId, 10);
    if (!Number.isFinite(fid) || fid <= 0) return res.status(400).json({ error: 'Invalid folderId' });

    const recursiveFlag = body.recursive === true || body.recursive === 1 || body.recursive === '1' || body.recursive === 'true'
      || req.query.recursive === '1' || req.query.recursive === 'true';

    if (!recursiveFlag) {
      const result = await rescanFolderOneLevel(fid);
      if (result.error) return res.status(result.status || 500).json({ error: result.error });
      await db.refreshFolderStats(fid);
      return res.json({ ...result, recursive: false, foldersScanned: 1 });
    }

    const totals = { added: 0, updated: 0, removed: 0, foldersAdded: 0, foldersScanned: 0, foldersSkipped: 0 };
    const queue = [fid];
    const seen = new Set();
    const MAX_FOLDERS = 10000;
    let rootPath = null;

    while (queue.length > 0 && totals.foldersScanned < MAX_FOLDERS) {
      const current = queue.shift();
      if (seen.has(current)) continue;
      seen.add(current);

      const result = await rescanFolderOneLevel(current);
      if (result.error) {
        if (current === fid) return res.status(result.status || 500).json({ error: result.error });
        totals.foldersSkipped++;
        continue;
      }
      if (!rootPath) rootPath = result.path;
      totals.added += result.added;
      totals.updated += result.updated;
      totals.removed += result.removed;
      totals.foldersAdded += result.foldersAdded;
      totals.foldersScanned++;

      const [children] = await db.connection.query(
        'SELECT id FROM folder_tree WHERE parent_id = ?',
        [current]
      );
      for (const c of children) {
        if (!seen.has(c.id)) queue.push(c.id);
      }
    }

    await db.refreshFolderStats(fid);
    res.json({
      success: true,
      path: rootPath,
      recursive: true,
      ...totals,
      truncated: queue.length > 0
    });
  } catch (err) {
    console.error('Folder rescan error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tree/delete-file', requireAuthWrapper, async (req, res) => {
  try {
    const { path } = req.body;
    if (!path) return res.status(400).json({ error: 'path required' });
    const winPath = path.replace(/\//g, '\\');
    const parts = winPath.replace(/\\/g, '/').split('/');
    const fileName = parts.pop();
    const folderPath = parts.join('\\');
    const [folderRow] = await db.connection.query('SELECT id FROM folder_tree WHERE folder_id = ?', [folderPath]);
    if (folderRow.length === 0) return res.json({ deleted: 0 });

    // Archive before delete
    const [fileRow] = await db.connection.query(
      'SELECT sf.id, sf.name, sf.size, sf.hash, sf.extension FROM scanned_files sf WHERE sf.name = ? AND sf.folder_id_int = ?',
      [fileName, folderRow[0].id]
    );
    if (fileRow.length > 0) {
      await db.archiveDeletedFiles([{
        id: fileRow[0].id, name: fileRow[0].name,
        path: winPath, size: fileRow[0].size,
        hash: fileRow[0].hash, extension: fileRow[0].extension
      }], 'delete-file');
    }

    const [result] = await db.connection.query(
      'DELETE FROM scanned_files WHERE name = ? AND folder_id_int = ?',
      [fileName, folderRow[0].id]
    );

    if (result.affectedRows > 0) {
      await db.refreshFolderStats(folderRow[0].id);
    }

    res.json({ deleted: result.affectedRows });
  } catch (err) {
    console.error('Delete file error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Serve tree view page
app.get('/jobs', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'jobs.html'));
});

app.get('/api/jobs', requireAuthWrapper, requirePhotoPermission, (req, res) => {
  try {
    const { status, type, limit } = req.query || {};
    res.json({ jobs: listJobs({ status, type, limit: parseInt(limit, 10) || 100 }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/jobs/:jobId', requireAuthWrapper, (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or expired' });
  res.json(job);
});

app.post('/api/jobs/:jobId/cancel', requireAuthWrapper, requirePhotoPermission, (req, res) => {
  try {
    const job = cancelJob(req.params.jobId, { reason: (req.body && req.body.reason) || 'Cancelled' });
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.get('/embeddings', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'embeddings.html'));
});

app.get('/tree', (req, res) => {
  const html = fs.readFileSync(join(__dirname, 'public', 'tree.html'), 'utf8');
  res.send(html);
});

app.get('/usage-chart', (req, res) => {
  const html = fs.readFileSync(join(__dirname, 'public', 'usage-chart.html'), 'utf8');
  res.send(html);
});

// Search files in a folder path
app.get('/api/search-folder', requireAuthWrapper, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Query required' });

    const normalizedQuery = q.replace(/\//g, '\\');
    // Find folder_tree id matching the path
    const [ftRows] = await db.connection.query(
      'SELECT id FROM folder_tree WHERE folder_id = ?',
      [normalizedQuery]
    );
    if (ftRows.length === 0) {
      return res.json({ folder: q, files: [] });
    }
    const folderIdInt = ftRows[0].id;

    const [rows] = await db.connection.query(
      `SELECT sf.id, sf.name, sf.size, sf.extension, ft.folder_id as folder_path
       FROM scanned_files sf
       LEFT JOIN folder_tree ft ON sf.folder_id_int = ft.id
       WHERE sf.folder_id_int = ?
       ORDER BY sf.size DESC
       LIMIT 100`,
      [folderIdInt]
    );

    res.json({
      folder: q,
      files: rows.map(r => ({
        id: r.id,
        name: r.name,
        path: r.folder_path ? r.folder_path + '\\' + r.name : r.name,
        size: r.size,
        sizeFormatted: formatBytes(parseInt(r.size)),
        extension: r.extension,
        isImage: ['jpg','jpeg','png','gif','bmp','webp','heic','heif','avif'].includes(r.extension?.toLowerCase()),
        isAudio: ['mp3','flac','wav','aac','ogg','m4a','wma','opus'].includes(r.extension?.toLowerCase()),
        isVideo: ['mp4','mkv','avi','mov','wmv','webm','m4v','mpg'].includes(r.extension?.toLowerCase())
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get duplicates from database
app.get('/api/duplicates', requireAuthWrapper, async (req, res) => {
  try {
    const minSize = parseInt(req.query.minSize) || 0;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);

    const [groups] = await db.connection.query(`
      SELECT hash, COUNT(*) as count, size
      FROM scanned_files
      WHERE hash IS NOT NULL AND size >= ?
      GROUP BY hash, size
      HAVING count > 1
      ORDER BY size DESC
      LIMIT ?
    `, [minSize, limit]);

    const duplicates = [];
    for (const group of groups) {
      const [files] = await db.connection.query(
        'SELECT sf.id, sf.name, sf.size, sf.extension, sf.hash, ft.folder_id as folder_path FROM scanned_files sf LEFT JOIN folder_tree ft ON sf.folder_id_int = ft.id WHERE sf.hash = ? AND sf.size = ?',
        [group.hash, group.size]
      );
      duplicates.push({
        hash: group.hash ? group.hash.substring(0, 16) + '...' : null,
        count: group.count,
        size: parseInt(group.size),
        sizeFormatted: formatBytes(parseInt(group.size)),
        wastedSpace: (group.count - 1) * parseInt(group.size),
        wastedFormatted: formatBytes((group.count - 1) * parseInt(group.size)),
        files: files.map(f => ({
          id: f.id,
          name: f.name,
          path: f.folder_path ? f.folder_path + '\\' + f.name : f.name,
          size: parseInt(f.size),
          sizeFormatted: formatBytes(parseInt(f.size)),
          extension: f.extension
        }))
      });
    }

    // Get totals
    const [totals] = await db.connection.query(`
      SELECT COUNT(*) as groups, SUM(cnt) as files, SUM(wasted) as wasted FROM (
        SELECT hash, COUNT(*) as cnt, (COUNT(*) - 1) * size as wasted
        FROM scanned_files WHERE hash IS NOT NULL AND size >= ?
        GROUP BY hash, size HAVING COUNT(*) > 1
      ) t
    `, [minSize]);

    res.json({
      groups: duplicates,
      totalGroups: totals[0].groups || 0,
      totalFiles: parseInt(totals[0].files) || 0,
      totalWasted: parseInt(totals[0].wasted) || 0,
      totalWastedFormatted: formatBytes(parseInt(totals[0].wasted) || 0)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Duplicate report API — folder-level analysis
app.get('/api/duplicates/report', requireAuthWrapper, async (req, res) => {
  try {
    const minSize = parseInt(req.query.minSize) || 0;
    const limit = Math.min(parseInt(req.query.limit) || 500, 2000);

    // Get all duplicate files with their folder info
    const [dupFiles] = await db.connection.query(`
      SELECT sf.id, sf.name, sf.size, sf.extension, sf.hash,
             ft.folder_id as folder_path, ft.id as tree_id, ft.folder_name
      FROM scanned_files sf
      LEFT JOIN folder_tree ft ON sf.folder_id_int = ft.id
      WHERE sf.hash IS NOT NULL
        AND sf.hash IN (
          SELECT hash FROM scanned_files
          WHERE hash IS NOT NULL AND size >= ?
          GROUP BY hash, size HAVING COUNT(*) > 1
        )
        AND sf.size >= ?
      ORDER BY sf.hash, sf.size DESC
    `, [minSize, minSize]);

    // Group by hash
    const hashMap = new Map();
    for (const file of dupFiles) {
      const key = `${file.hash}_${file.size}`;
      if (!hashMap.has(key)) {
        hashMap.set(key, { hash: file.hash, size: parseInt(file.size), files: [] });
      }
      hashMap.get(key).files.push({
        id: file.id,
        name: file.name,
        path: file.folder_path ? file.folder_path + '\\' + file.name : file.name,
        extension: file.extension,
        folderId: file.tree_id,
        folderName: file.folder_name || ''
      });
    }

    const allGroups = Array.from(hashMap.values()).filter(g => g.files.length > 1);

    // Analyze by drive
    const driveStats = {};
    for (const group of allGroups) {
      for (const file of group.files) {
        const drive = file.path.substring(0, 2) || '??';
        if (!driveStats[drive]) driveStats[drive] = { files: 0, wasted: 0, groups: new Set() };
        driveStats[drive].files++;
        driveStats[drive].wasted += group.size;
        driveStats[drive].groups.add(group.hash);
      }
    }

    const driveReport = Object.entries(driveStats)
      .map(([drive, s]) => ({
        drive,
        files: s.files,
        wasted: s.wasted,
        wastedFormatted: formatBytes(s.wasted),
        groups: s.groups.size
      }))
      .sort((a, b) => b.wasted - a.wasted);

    // Analyze by folder
    const folderStats = {};
    for (const group of allGroups) {
      for (const file of group.files) {
        const fid = file.folderId || file.folderName;
        if (!folderStats[fid]) folderStats[fid] = { folderId: file.folderId, name: file.folderName || fid, files: 0, wasted: 0, groups: new Set() };
        folderStats[fid].files++;
        folderStats[fid].wasted += group.size;
        folderStats[fid].groups.add(group.hash);
      }
    }

    const folderReport = Object.entries(folderStats)
      .map(([fid, s]) => ({
        folderId: s.folderId,
        name: s.name,
        files: s.files,
        wasted: s.wasted,
        wastedFormatted: formatBytes(s.wasted),
        groups: s.groups.size
      }))
      .sort((a, b) => b.wasted - a.wasted)
      .slice(0, 30);

    // Summary
    const totalWasted = allGroups.reduce((sum, g) => sum + (g.files.length - 1) * g.size, 0);
    const totalDupFiles = allGroups.reduce((sum, g) => sum + g.files.length, 0);

    // Top groups (limited, sorted by wasted space)
    const topGroups = allGroups
      .sort((a, b) => (b.files.length - 1) * b.size - (a.files.length - 1) * a.size)
      .slice(0, limit)
      .map(g => ({
        hash: g.hash ? g.hash.substring(0, 12) + '...' : null,
        size: g.size,
        sizeFormatted: formatBytes(g.size),
        count: g.files.length,
        wasted: (g.files.length - 1) * g.size,
        wastedFormatted: formatBytes((g.files.length - 1) * g.size),
        files: g.files.map(f => ({
          name: f.name,
          path: f.path,
          folderId: f.folderId,
          folderName: f.folderName,
          extension: f.extension
        }))
      }));

    res.json({
      summary: {
        totalGroups: allGroups.length,
        totalDupFiles: totalDupFiles,
        totalWasted,
        totalWastedFormatted: formatBytes(totalWasted),
        hashCoverage: { hashed: 9843, total: 4166048 }
      },
      driveReport,
      folderReport,
      topGroups
    });
  } catch (err) {
    console.error('Backup analysis error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Serve duplicates report page
app.get('/duplicates/report', (req, res) => {
  const html = fs.readFileSync(join(__dirname, 'public', 'duplicates-report.html'), 'utf8');
  res.send(html);
});

// Backup analysis API — check which files have copies elsewhere
let backupAnalysisCache = null;
let backupAnalysisCacheTime = 0;
let backupAnalysisCacheFolder = null;

// Preloaded duplicate groups: hash → [{id, name, path, size, extension, folderId, drive}]
let dupGroupMap = null;
let dupGroupLoadedAt = 0;

async function preloadDupGroups() {
  const t = Date.now();
  const map = new Map();
  const BATCH = 10000;
  let offset = 0;
  while (true) {
    const [rows] = await db.connection.query({
      sql: `SELECT sf.hash, sf.id, sf.name, sf.size, sf.extension,
              sf.folder_id_int, ft.folder_id as folder_path, ft.folder_name
            FROM scanned_files sf
            LEFT JOIN folder_tree ft ON sf.folder_id_int = ft.id
            WHERE sf.hash IS NOT NULL
            ORDER BY sf.hash
            LIMIT ? OFFSET ?`,
      timeout: 60000
    }, [BATCH, offset]);
    if (rows.length === 0) break;
    for (const r of rows) {
      if (!map.has(r.hash)) map.set(r.hash, []);
      map.get(r.hash).push({
        id: r.id, name: r.name, size: r.size, extension: r.extension,
        path: r.folder_path ? r.folder_path + '\\' + r.name : r.name,
        folderId: r.folder_id_int,
        folder: r.folder_name || r.folder_path,
        drive: (r.folder_path || '').substring(0, 2) || '??'
      });
    }
    offset += BATCH;
    if (rows.length < BATCH) break;
  }
  // Only keep hashes with >1 file (actual duplicates)
  let removed = 0;
  for (const [hash, files] of map) {
    if (files.length <= 1) { map.delete(hash); removed++; }
  }
  dupGroupMap = map;
  dupGroupLoadedAt = Date.now();
  console.log(`[preload] dupGroupMap: ${map.size} groups loaded, ${removed} singletons removed (${Date.now() - t}ms)`);
}

// Preload same-name groups skipped — too many unhashed files. Computed on-the-fly per request.

app.get('/api/backup-analysis', requireAuthWrapper, async (req, res) => {
  const startTime = Date.now();
  try {
    const folderRaw = req.query.folder;
    if (!folderRaw) return res.status(400).json({ error: 'folder parameter required' });
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const folder = folderRaw.replace(/\\/g, '/').replace(/\/+$/, '');

    console.log(`[backup-analysis] folder=${folder} limit=${limit}`);

    // Check cache (5 min TTL)
    const now = Date.now();
    if (backupAnalysisCache && backupAnalysisCacheFolder === folder && (now - backupAnalysisCacheTime) < 300000) {
      console.log(`[backup-analysis] cache hit (${Date.now() - startTime}ms)`);
      return res.json(backupAnalysisCache);
    }

    // Step 1: Get folder IDs
    const t1 = Date.now();
    const [targetFolderRows] = await db.connection.query({
      sql: `SELECT id, folder_id FROM folder_tree WHERE REPLACE(folder_id, '\\\\', '/') LIKE ?`,
      timeout: 30000
    }, [folder + '%']);
    const targetFolderIds = targetFolderRows.map(f => f.id);
    const targetFolderIdSet = new Set(targetFolderIds);
    console.log(`[backup-analysis] folder IDs: ${targetFolderIds.length} (${Date.now() - t1}ms)`);

    // Step 2: Get files in target folder
    let files = [];
    if (targetFolderIds.length > 0) {
      const t2 = Date.now();
      const BATCH = 500;
      for (let i = 0; i < targetFolderIds.length; i += BATCH) {
        const batch = targetFolderIds.slice(i, i + BATCH);
        const placeholders = batch.map(() => '?').join(',');
        const [batchFiles] = await db.connection.query({
          sql: `SELECT sf.id, sf.name, sf.size, sf.hash, sf.extension, sf.folder_id_int
            FROM scanned_files sf
            WHERE sf.folder_id_int IN (${placeholders})`,
          timeout: 30000
        }, batch);
        files.push(...batchFiles);
      }
      console.log(`[backup-analysis] files: ${files.length} (${Date.now() - t2}ms)`);
    }

    // Step 3: Classify using preloaded maps (instant)
    const t3 = Date.now();
    const hashed = files.filter(f => f.hash);
    const unhashed = files.filter(f => !f.hash);
    const withCopy = [];
    const withoutCopy = [];

    for (const file of hashed) {
      const allCopies = dupGroupMap ? dupGroupMap.get(file.hash) : null;
      if (allCopies && allCopies.length > 1) {
        const outsideCopies = allCopies.filter(c => c.id !== file.id && !targetFolderIdSet.has(c.folderId));
        if (outsideCopies.length > 0) {
          withCopy.push({
            id: file.id, name: file.name, path: file.name,
            size: file.size, sizeFormatted: formatBytes(parseInt(file.size)),
            extension: file.extension, copies: outsideCopies.length,
            copyLocations: outsideCopies.slice(0, 5)
          });
        } else {
          withoutCopy.push({ id: file.id, name: file.name, path: file.name, size: file.size, sizeFormatted: formatBytes(parseInt(file.size)), extension: file.extension });
        }
      } else {
        withoutCopy.push({ id: file.id, name: file.name, path: file.name, size: file.size, sizeFormatted: formatBytes(parseInt(file.size)), extension: file.extension });
      }
    }
    console.log(`[backup-analysis] classify: ${withCopy.length} withCopy, ${withoutCopy.length} unique (${Date.now() - t3}ms)`);

    // Step 4: Same name+size groups — query unhashed files outside target folder
    const t4 = Date.now();
    const sameName = [];
    if (unhashed.length > 0 && targetFolderIds.length > 0) {
      try {
        const nameSizeMap = new Map();
        for (const f of unhashed) {
          const key = f.name + '_' + f.size;
          if (!nameSizeMap.has(key)) nameSizeMap.set(key, []);
          nameSizeMap.get(key).push(f);
        }
        const uniqueNames = [...nameSizeMap.keys()];
        const BATCH = 200;
        for (let i = 0; i < uniqueNames.length; i += BATCH) {
          const batch = uniqueNames.slice(i, i + BATCH);
          // Batch query: find files with matching name+size outside target folder
          const nameSizeConditions = batch.map(() => '(sf.name = ? AND sf.size = ?)').join(' OR ');
          const nameSizeParams = [];
          for (const key of batch) {
            const lastUnderscore = key.lastIndexOf('_');
            nameSizeParams.push(key.substring(0, lastUnderscore), parseInt(key.substring(lastUnderscore + 1)));
          }
          const exPh = targetFolderIds.map(() => '?').join(',');
          const [matches] = await db.connection.query({
            sql: `SELECT sf.id, sf.name, sf.size, sf.extension,
                    sf.folder_id_int, ft.folder_id as folder_path, ft.folder_name
                  FROM scanned_files sf
                  LEFT JOIN folder_tree ft ON sf.folder_id_int = ft.id
                  WHERE (${nameSizeConditions})
                    AND sf.folder_id_int NOT IN (${exPh})`,
            timeout: 30000
          }, [...nameSizeParams, ...targetFolderIds]);
          const matchMap = new Map();
          for (const m of matches) {
            const key = m.name + '_' + m.size;
            if (!matchMap.has(key)) matchMap.set(key, []);
            matchMap.get(key).push({
              id: m.id, path: m.folder_path ? m.folder_path + '\\' + m.name : m.name,
              name: m.name, folder: m.folder_name || m.folder_path,
              drive: (m.folder_path || '').substring(0, 2) || '??', size: m.size
            });
          }
          for (const key of batch) {
            const localFiles = nameSizeMap.get(key);
            const outsideCopies = matchMap.get(key);
            if (localFiles && outsideCopies && outsideCopies.length > 0) {
              for (const lf of localFiles) {
                sameName.push({
                  id: lf.id, name: lf.name, path: lf.name,
                  size: lf.size, sizeFormatted: formatBytes(parseInt(lf.size)),
                  extension: lf.extension, copies: outsideCopies.length,
                  copyLocations: outsideCopies.slice(0, 5)
                });
              }
            }
          }
        }
        sameName.sort((a, b) => b.size - a.size);
      } catch (e) { console.warn('[backup-analysis] sameName failed:', e.message); }
    }
    console.log(`[backup-analysis] sameName: ${sameName.length} (${Date.now() - t4}ms)`);

    // Step 5: Build response
    const wastedByCopies = withCopy.reduce((sum, f) => sum + f.size * f.copies, 0);
    const response = {
      summary: {
        totalFiles: files.length,
        hashed: hashed.length,
        unhashed: unhashed.length,
        withCopy: withCopy.length,
        withoutCopy: withoutCopy.length,
        sameName: sameName.length,
        wastedSpace: wastedByCopies,
        wastedFormatted: formatBytes(wastedByCopies),
        dupGroupsLoaded: dupGroupMap ? dupGroupMap.size : 0
      },
      withCopy: withCopy.slice(0, limit),
      withoutCopy: withoutCopy.slice(0, limit),
      sameName: sameName.slice(0, limit),
      unhashed: unhashed.sort((a, b) => b.size - a.size).map(f => ({
        id: f.id, name: f.name, path: f.name,
        size: f.size, sizeFormatted: formatBytes(parseInt(f.size)), extension: f.extension
      }))
    };

    backupAnalysisCache = response;
    backupAnalysisCacheTime = now;
    backupAnalysisCacheFolder = folder;
    console.log(`[backup-analysis] done: ${response.summary.totalFiles} files (${Date.now() - startTime}ms)`);
    res.json(response);
  } catch (err) {
    console.error(`[backup-analysis] ERROR after ${Date.now() - startTime}ms:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// Mark deleted files — removes files from DB that no longer exist on disk
app.post('/api/mark-deleted', requireAuthWrapper, async (req, res) => {
  try {
    const { folder: folderRaw, mode } = req.body;
    const folder = (folderRaw || '%').replace(/\\/g, '/').replace(/\/+$/, '');

    // Get matching folder IDs first (index-friendly)
    const [targetFolders] = await db.connection.query(
      `SELECT id FROM folder_tree WHERE REPLACE(folder_id, '\\\\', '/') LIKE ?`,
      [folder + '%']
    );
    const targetIds = targetFolders.map(f => f.id);

    if (targetIds.length === 0) {
      return res.json({ deleted: 0, kept: 0, total: 0 });
    }
    const ph = targetIds.map(() => '?').join(',');

    let query, params;
    if (mode === 'has-copy') {
      query = `SELECT sf.id, CONCAT(ft.folder_id, '\\\\', sf.name) as path FROM scanned_files sf
               JOIN folder_tree ft ON ft.id = sf.folder_id_int
               WHERE sf.hash IS NOT NULL
                 AND sf.hash IN (
                   SELECT hash FROM scanned_files
                   WHERE hash IS NOT NULL
                   GROUP BY hash, size HAVING COUNT(*) > 1
                 )
                 AND sf.folder_id_int IN (${ph})`;
      params = targetIds;
    } else {
      query = `SELECT sf.id, CONCAT(ft.folder_id, '\\\\', sf.name) as path FROM scanned_files sf
               JOIN folder_tree ft ON ft.id = sf.folder_id_int
               WHERE sf.folder_id_int IN (${ph})`;
      params = targetIds;
    }

    const [files] = await db.connection.query(query, params);

    let deleted = 0;
    let kept = 0;
    let skippedOffline = 0;
    const missingIds = [];

    const { online: reachableFiles, skippedOffline: offlineFiles } = await partitionByDriveOnline(files, {
      log: console.warn,
      timeoutMs: 3000
    });
    skippedOffline = offlineFiles.length;
    kept += offlineFiles.length; // keep DB rows when drive offline

    const BATCH = 100;
    for (let i = 0; i < reachableFiles.length; i += BATCH) {
      const batch = reachableFiles.slice(i, i + BATCH);
      const checks = batch.map(file => 
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), 2000);
          fs.access(file.path, fs.constants.F_OK, (err) => {
            clearTimeout(timer);
            resolve(!err);
          });
        })
      );
      const results = await Promise.all(checks);
      
      for (let j = 0; j < batch.length; j++) {
        if (results[j]) {
          kept++;
        } else {
          missingIds.push(batch[j].id);
          deleted++;
        }
      }
    }

    if (missingIds.length > 0) {
      const DEL_BATCH = 500;
      for (let i = 0; i < missingIds.length; i += DEL_BATCH) {
        const batch = missingIds.slice(i, i + DEL_BATCH);
        const placeholders = batch.map(() => '?').join(',');
        await db.connection.query(`DELETE FROM scanned_files WHERE id IN (${placeholders})`, batch);
      }
    }

    backupAnalysisCache = null;
    photosCache = null;
    musicCache = null;
    moviesCache = null;

    res.json({ deleted, kept, skippedOffline, total: files.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve backup analysis page
app.get('/backup', (req, res) => {
  const html = fs.readFileSync(join(__dirname, 'public', 'backup-analysis.html'), 'utf8');
  res.send(html);
});

app.get('/drive-usage', (req, res) => {
  const html = fs.readFileSync(join(__dirname, 'public', 'drive-usage.html'), 'utf8');
  res.send(html);
});

app.get('/deleted-archive', (req, res) => {
  const html = fs.readFileSync(join(__dirname, 'public', 'deleted-archive.html'), 'utf8');
  res.send(html);
});

// API: Get deleted files archive
app.get('/api/deleted-archive', requireAuthWrapper, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
    const offset = parseInt(req.query.offset) || 0;
    const data = await db.getDeletedFilesArchive(limit, offset);
    res.json(data);
  } catch (err) {
    console.error('Deleted archive API error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// API: Restore file from archive
app.post('/api/deleted-archive/restore', requireAuthWrapper, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !ids.length) return res.status(400).json({ error: 'ids required' });
    const placeholders = ids.map(() => '?').join(',');
    const [files] = await db.connection.query(
      `SELECT * FROM deleted_files_archive WHERE id IN (${placeholders})`, ids
    );
    let restored = 0;
    for (const f of files) {
      if (f.path) {
        const exists = await new Promise(r => fs.access(f.path, fs.constants.F_OK, err => r(!err)));
        if (exists) {
          const parts = f.path.replace(/\\/g, '/').split('/');
          const fileName = parts.pop();
          const folderPath = parts.join('\\');
          const [folderRow] = await db.connection.query('SELECT id FROM folder_tree WHERE folder_id = ?', [folderPath]);
          if (folderRow.length > 0) {
            await db.connection.query(
              'INSERT INTO scanned_files (name, size, hash, extension, folder_id_int) VALUES (?, ?, ?, ?, ?)',
              [fileName, f.size, f.hash, f.extension, folderRow[0].id]
            );
            restored++;
        }
      }
      console.log(`[backup-analysis] hashes: ${hashes.length}, dups: ${dupMap.size} (${Date.now() - t3}ms)`);
    }
    }
    if (restored > 0) {
      await db.connection.query(`DELETE FROM deleted_files_archive WHERE id IN (${placeholders})`, ids);
    }
    res.json({ restored, total: files.length });
  } catch (err) {
    console.error('Restore archive error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// API: Permanently delete from archive
app.post('/api/deleted-archive/purge', requireAuthWrapper, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !ids.length) return res.status(400).json({ error: 'ids required' });
    const placeholders = ids.map(() => '?').join(',');
    const [result] = await db.connection.query(
      `DELETE FROM deleted_files_archive WHERE id IN (${placeholders})`, ids
    );
    res.json({ purged: result.affectedRows });
  } catch (err) {
    console.error('Purge archive error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

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
    
    // Set cookie so img tags can authenticate automatically
    res.cookie('silverfs_token', result.token, {
      httpOnly: false,
      secure: true,
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000
    });
    
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
      return res.status(401).json({ valid: false });
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      return res.status(401).json({ valid: false });
    }

    const token = parts[1];
    const result = authManager.verifyToken(token);
    res.status(result.valid ? 200 : 401).json(result);
  } catch (err) {
    res.status(401).json({ valid: false, error: 'Invalid token' });
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
      
      // Set cookie so img tags can authenticate automatically
      res.cookie('silverfs_token', result.token, {
        httpOnly: false,
        secure: true,
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000
      });
      
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

// Cached photos data
let photosCache = null;
let photosCacheTime = 0;
const PHOTOS_CACHE_DURATION = 2 * 60 * 1000; // 2 minutes

// Cached music data
let musicCache = null;
let musicCacheTime = 0;
const MUSIC_CACHE_DURATION = 2 * 60 * 1000;

// Cached movies data
let moviesCache = null;
let moviesCacheTime = 0;
const MOVIES_CACHE_DURATION = 2 * 60 * 1000;

// Get cached summary statistics for dashboard header
app.get('/api/summary', requireAuthWrapper, async (req, res) => {
  try {
    const now = Date.now();
    
    // Return cached data if still valid
    if (summaryCache && (now - summaryCacheTime) < SUMMARY_CACHE_DURATION) {
      return res.json(summaryCache);
    }
    
    // Use cached media data if available, otherwise fetch fresh
    const cacheNow = Date.now();
    let photosData, musicData, moviesData;
    
    if (photosCache && (cacheNow - photosCacheTime) < PHOTOS_CACHE_DURATION) {
      photosData = photosCache;
    } else {
      photosData = await db.getPhotosWithMetadata();
      photosCache = photosData;
      photosCacheTime = cacheNow;
    }
    
    if (musicCache && (cacheNow - musicCacheTime) < MUSIC_CACHE_DURATION) {
      musicData = musicCache;
    } else {
      musicData = await db.getMusicWithMetadata();
      musicCache = musicData;
      musicCacheTime = cacheNow;
    }
    
    if (moviesCache && (cacheNow - moviesCacheTime) < MOVIES_CACHE_DURATION) {
      moviesData = moviesCache;
    } else {
      moviesData = await db.getVideosWithMetadata();
      moviesCache = moviesData;
      moviesCacheTime = cacheNow;
    }
    
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
let fileTypeBreakdownCache = null;
let fileTypeBreakdownCacheHash = null;

app.get('/api/file-type-breakdown', async (req, res) => {
  try {
    // Check if cache is still valid by comparing file count + total size as a fingerprint
    const [stats] = await db.connection.query('SELECT COUNT(*) as cnt, COALESCE(SUM(size),0) as total_size FROM scanned_files');
    const cacheKey = `${stats[0].cnt}_${stats[0].total_size}`;
    
    if (fileTypeBreakdownCache && fileTypeBreakdownCacheHash === cacheKey) {
      return res.json(fileTypeBreakdownCache);
    }
    const connection = db.connection;
    if (!connection) {
      throw new Error('Database not connected');
    }
    
    const fileTypeCategories = {
      script: ['.js', '.py', '.sh', '.bat', '.cmd', '.ps1', '.rb', '.pl', '.php', '.java', '.c', '.cpp', '.cs', '.go', '.rs', '.ts', '.jsx', '.tsx', '.vue', '.swift', '.kt', '.m', '.r', '.lua', '.dart', '.zig', '.hs', '.scala', '.ex', '.exs', '.clj'],
      document: ['.pdf', '.doc', '.docx', '.txt', '.rtf', '.odt', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.md', '.tex', '.epub', '.mobi', '.pages', '.numbers', '.key', '.odp', '.ods', '.html', '.htm'],
      image: ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.svg', '.webp', '.ico', '.tiff', '.tif', '.heic', '.heif', '.raw', '.cr2', '.nef', '.arw', '.dng', '.orf', '.rw2', '.pef', '.avif', '.jxl'],
      music: ['.mp3', '.flac', '.wav', '.aac', '.ogg', '.m4a', '.wma', '.opus', '.ape', '.alac', '.aiff', '.mid', '.midi'],
      video: ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg', '.3gp', '.ts', '.mts', '.vob', '.ogv'],
      ai: ['.safetensors', '.gguf', '.ggml', '.bin', '.onnx', '.pt', '.pth', '.ckpt', '.lora', '.loha', '.locon', '.lycoris', '.gguf', '.npz', '.npy', '.h5', '.hdf5', '.pb', '.tflite', '.mlmodel', '.coreml', '.model', '.weights'],
      archive: ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.tar.gz', '.tar.bz2', '.tar.xz', '.zst', '.lz4', '.cab', '.iso', '.dmg'],
      design: ['.psd', '.ai', '.sketch', '.fig', '.xd', '.indd', '.afdesign', '.afphoto', '.kra', '.xcf', '.blend', '.ma', '.mb'],
      cad: ['.dwg', '.dxf', '.step', '.stp', '.iges', '.igs', '.stl', '.obj', '.fbx', '.3ds', '.dae', '.3mf', '.amf'],
      data: ['.db', '.sqlite', '.sqlite3', '.sql', '.json', '.xml', '.yaml', '.yml', '.toml', '.parquet', '.arrow', '.avro', '.hdf5'],
      font: ['.ttf', '.otf', '.woff', '.woff2', '.eot', '.fon'],
      log: ['.log', '.out', '.err', '.trace', '.dmp'],
      game: ['.exe', '.apk', '.ipa', '.app', '.dmg', '.rom', '.sav', '.nes', '.snes', '.gba', '.nds', '.psp', '.ps2', '.ps3', '.xbox'],
      system: ['.dll', '.sys', '.so', '.dylib', '.ini', '.cfg', '.conf', '.config', '.plist', '.reg', '.inf', '.cat'],
      program: ['.exe', '.msi', '.deb', '.rpm', '.pkg', '.appimage', '.snap', '.flatpak', '.app', '.dmg', '.apk', '.ipa'],
      other: []
    };
    
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
    
    const breakdown = {};
    for (const cat of Object.keys(fileTypeCategories)) {
      breakdown[cat] = { count: 0, size: 0, extensions: [] };
    }
    breakdown.other = { count: 0, size: 0, extensions: [] };
    
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
    
    let totalFiles = 0;
    let totalSize = 0;
    Object.values(breakdown).forEach(category => {
      totalFiles += category.count;
      totalSize += category.size;
    });
    
    // Build extension-to-category lookup for top folders query
    const extToCategory = {};
    for (const [category, extensions] of Object.entries(fileTypeCategories)) {
      for (const ext of extensions) {
        extToCategory[ext] = category;
      }
    }

    // Get top folders per category (in parallel)
    const topFolders = {};
    const activeCategories = Object.entries(breakdown).filter(([_, d]) => d.count > 0);
    
    const folderPromises = activeCategories.map(async ([category]) => {
      const exts = fileTypeCategories[category] || [];
      if (exts.length === 0) return;
      const placeholders = exts.map(() => '?').join(',');
      try {
        const [folderRows] = await connection.query(`
          SELECT ft.id as folder_id, 
            SUBSTRING_INDEX(SUBSTRING_INDEX(REPLACE(ft.folder_id, '\\\\', '/'), '/', LENGTH(REPLACE(ft.folder_id, '\\\\', '/')) - LENGTH(REPLACE(REPLACE(ft.folder_id, '\\\\', '/'), '/', '')) - 1), '/', -2) as folder_path,
            ft.folder_id as full_path,
            COUNT(*) as file_count,
            SUM(sf.size) as total_size
          FROM scanned_files sf
          JOIN folder_tree ft ON sf.folder_id_int = ft.id
          WHERE LOWER(sf.extension) IN (${placeholders})
          GROUP BY ft.id, ft.folder_id ORDER BY total_size DESC LIMIT 5
        `, exts.map(e => e.replace('.', '')));
        topFolders[category] = folderRows.map(r => ({
          id: r.folder_id,
          path: r.folder_path,
          fullPath: r.full_path,
          count: parseInt(r.file_count),
          size: parseInt(r.total_size),
          sizeFormatted: formatBytes(parseInt(r.total_size))
        }));
      } catch (err) {
        console.warn(`Top folders query failed for ${category}:`, err.message);
      }
    });
    await Promise.all(folderPromises);

    // Per-extension top 5 folders for AI category
    const aiExtensions = fileTypeCategories.ai || [];
    const aiPerExtFolders = {};
    try {
      if (aiExtensions.length > 0) {
        const placeholders = aiExtensions.map(() => '?').join(',');
        const [aiRows] = await connection.query(
          `SELECT ext, folder_path, full_path, COUNT(*) as file_count, SUM(size) as total_size FROM (
            SELECT 
              LOWER(sf.extension) as ext,
              SUBSTRING_INDEX(SUBSTRING_INDEX(REPLACE(ft.folder_id, '\\\\', '/'), '/', LENGTH(REPLACE(ft.folder_id, '\\\\', '/')) - LENGTH(REPLACE(REPLACE(ft.folder_id, '\\\\', '/'), '/', '')) - 1), '/', -2) as folder_path,
              ft.folder_id as full_path,
              sf.size
            FROM scanned_files sf
            JOIN folder_tree ft ON sf.folder_id_int = ft.id
            WHERE LOWER(sf.extension) IN (${placeholders})
          ) t GROUP BY ext, full_path, folder_path ORDER BY ext, total_size DESC LIMIT 200`,
          aiExtensions.map(e => e.replace('.', ''))
        );
        
        const extFolderMap = {};
        for (const row of aiRows) {
          const ext = '.' + row.ext;
          if (!extFolderMap[ext]) extFolderMap[ext] = [];
          if (extFolderMap[ext].length < 10) {
            extFolderMap[ext].push({
              path: row.folder_path,
              fullPath: row.full_path,
              count: parseInt(row.file_count),
              size: parseInt(row.total_size),
              sizeFormatted: formatBytes(parseInt(row.total_size))
            });
          }
        }
        for (const ext of aiExtensions) {
          if (extFolderMap[ext]) aiPerExtFolders[ext] = extFolderMap[ext];
        }
      }
    } catch (aiErr) {
      console.warn('AI per-extension query failed:', aiErr.message);
    }

    const response = {
      total: {
        files: totalFiles,
        size: totalSize,
        sizeFormatted: formatBytes(totalSize)
      },
      categories: {}
    };
    
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
        })),
        topFolders: topFolders[category] || []
      };
    });

    if (response.categories.ai) {
      response.categories.ai.perExtFolders = aiPerExtFolders;
    }

    // Global top folders (all file types) - in parallel
    try {
      const [topBySize, topByCount] = await Promise.all([
        connection.query(`
          SELECT ft.id as folder_id, 
            SUBSTRING_INDEX(SUBSTRING_INDEX(REPLACE(ft.folder_id, '\\\\', '/'), '/', LENGTH(REPLACE(ft.folder_id, '\\\\', '/')) - LENGTH(REPLACE(REPLACE(ft.folder_id, '\\\\', '/'), '/', '')) - 1), '/', -2) as folder_path,
            ft.folder_id as full_path,
            COUNT(*) as file_count,
            SUM(sf.size) as total_size
          FROM scanned_files sf
          JOIN folder_tree ft ON sf.folder_id_int = ft.id
          WHERE sf.extension IS NOT NULL AND sf.extension != ''
          GROUP BY ft.id, ft.folder_id ORDER BY total_size DESC LIMIT 20
        `),
        connection.query(`
          SELECT ft.id as folder_id, 
            SUBSTRING_INDEX(SUBSTRING_INDEX(REPLACE(ft.folder_id, '\\\\', '/'), '/', LENGTH(REPLACE(ft.folder_id, '\\\\', '/')) - LENGTH(REPLACE(REPLACE(ft.folder_id, '\\\\', '/'), '/', '')) - 1), '/', -2) as folder_path,
            ft.folder_id as full_path,
            COUNT(*) as file_count,
            SUM(sf.size) as total_size
          FROM scanned_files sf
          JOIN folder_tree ft ON sf.folder_id_int = ft.id
          WHERE sf.extension IS NOT NULL AND sf.extension != ''
          GROUP BY ft.id, ft.folder_id ORDER BY file_count DESC LIMIT 10
        `)
      ]);

      response.topFoldersBySize = topBySize[0].map(r => ({
        id: r.folder_id,
        path: r.folder_path,
        fullPath: r.full_path,
        count: parseInt(r.file_count),
        size: parseInt(r.total_size),
        sizeFormatted: formatBytes(parseInt(r.total_size))
      }));

      response.topFoldersByCount = topByCount[0].map(r => ({
        id: r.folder_id,
        path: r.folder_path,
        fullPath: r.full_path,
        count: parseInt(r.file_count),
        size: parseInt(r.total_size),
        sizeFormatted: formatBytes(parseInt(r.total_size))
      }));
    } catch (folderErr) {
      console.warn('Global folder query failed:', folderErr.message);
    }
    
    fileTypeBreakdownCache = response;
    fileTypeBreakdownCacheHash = cacheKey;
    res.json(response);
  } catch (err) {
    console.error('Error getting file type breakdown:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get all photos with optional search and filters
app.get('/api/photos', requireAuthWrapper, requirePhotoPermission, async (req, res) => {
  try {
    const { search, filter, camera, model, year, month, days, face } = req.query;
    
    // Use cached data if available
    const now = Date.now();
    let photos;
    if (photosCache && (now - photosCacheTime) < PHOTOS_CACHE_DURATION) {
      photos = photosCache;
    } else {
      photos = await db.getPhotosWithMetadata();
      photosCache = photos;
      photosCacheTime = now;
    }
    
    // Filter by face group
    if (face) {
      if (face === 'none') {
        // Photos with no faces
        const [rows] = await db.connection.execute(
          'SELECT DISTINCT file_id FROM detected_faces WHERE face_group_id IS NULL AND confidence > 0'
        );
        const withFaces = new Set(rows.map(r => r.file_id));
        photos = photos.filter(p => !withFaces.has(p.id));
      } else if (face === 'ignored') {
        // Photos with ignored faces
        const [rows] = await db.connection.execute(
          "SELECT DISTINCT file_id FROM detected_faces WHERE all_expressions IS NOT NULL AND JSON_EXTRACT(all_expressions, '$.invalid') = true"
        );
        const fileIds = new Set(rows.map(r => r.file_id));
        photos = photos.filter(p => fileIds.has(p.id));
      } else {
        // Photos with specific face group
        const groupId = parseInt(face);
        const [rows] = await db.connection.execute(
          'SELECT DISTINCT file_id FROM detected_faces WHERE face_group_id = ?', [groupId]
        );
        const fileIds = new Set(rows.map(r => r.file_id));
        photos = photos.filter(p => fileIds.has(p.id));
      }
    }
    
    // Filter out photos with future dates
    const today = new Date();
    photos = photos.filter(photo => {
      if (!photo.date_taken) return true;
      const photoDate = new Date(photo.date_taken);
      return photoDate <= today;
    });
    
    // Default: last 7 days if no other filter specified (including days)
    const hasAnyFilter = search || filter || camera || model || year || month || face || (days !== undefined && days !== '');
    if (!hasAnyFilter) {
      const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
      photos = photos.filter(photo => {
        if (!photo.date_taken) return false;
        return new Date(photo.date_taken) >= sevenDaysAgo;
      });
    } else if (days !== undefined && days !== '' && parseInt(days) > 0) {
      // Explicit days filter overrides default
      const daysAgo = new Date(today.getTime() - parseInt(days) * 24 * 60 * 60 * 1000);
      photos = photos.filter(photo => {
        if (!photo.date_taken) return false;
        return new Date(photo.date_taken) >= daysAgo;
      });
    }
    // days=0 means "all time" — no date filter applied
    
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
      const ext = filter.toLowerCase();
      photos = photos.filter(photo => {
        const photoExt = photo.name.split('.').pop().toLowerCase();
        return photoExt === ext;
      });
    }
    
    // Apply camera filter
    if (camera) {
      const camLower = camera.toLowerCase();
      photos = photos.filter(photo => {
        const make = (photo.camera_make || '').toLowerCase();
        const model = (photo.camera_model || '').toLowerCase();
        const combined = (make + ' ' + model).trim();
        return make.includes(camLower) || model.includes(camLower) || combined.includes(camLower);
      });
    }
    
    // Apply model filter
    if (model) {
      const modelLower = model.toLowerCase();
      photos = photos.filter(photo => 
        (photo.camera_model && photo.camera_model.toLowerCase().includes(modelLower))
      );
    }
    
    // Apply year filter
    if (year) {
      photos = photos.filter(photo => {
        if (!photo.date_taken) return false;
        return new Date(photo.date_taken).getFullYear() === parseInt(year);
      });
    }
    
    // Apply month filter
    if (month) {
      photos = photos.filter(photo => {
        if (!photo.date_taken) return false;
        return new Date(photo.date_taken).getMonth() + 1 === parseInt(month);
      });
    }
    
    // Calculate stats
    const totalSize = photos.reduce((sum, p) => sum + Number(p.size), 0);
    const uniqueCameras = new Set(photos.map(p => p.camera_make).filter(Boolean)).size;
    const withGPS = photos.filter(p => p.latitude !== null).length;
    
    // Build filter options from full dataset (before filtering)
    const cameraCounts = {};
    photosCache.forEach(p => {
      const cam = [p.camera_make, p.camera_model].filter(Boolean).join(' ');
      if (cam) cameraCounts[cam] = (cameraCounts[cam] || 0) + 1;
    });
    const allCameras = Object.entries(cameraCounts).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
    
    const modelCounts = {};
    photosCache.forEach(p => {
      if (p.camera_model) modelCounts[p.camera_model] = (modelCounts[p.camera_model] || 0) + 1;
    });
    const allModels = Object.entries(modelCounts).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
    const allYears = [...new Set(photosCache.map(p => p.date_taken ? new Date(p.date_taken).getFullYear() : null).filter(Boolean))].sort((a, b) => b - a);
    const allMonths = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    
    res.json({
      photos,
      stats: {
        totalPhotos: photos.length,
        totalSize: formatBytes(totalSize),
        uniqueCameras,
        withGPS
      },
      filters: {
        cameras: allCameras,
        models: allModels,
        years: allYears,
        months: allMonths.map((name, i) => ({ name, value: i + 1 }))
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a photo by ID (removes from DB and disk)
app.delete('/api/photos/:id', requireAuthWrapper, requirePhotoPermission, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.deletePhoto(parseInt(id));
    if (result.deleted > 0 && result.path) {
      // Try to delete the actual file from disk
      try { await fs.promises.unlink(result.path); } catch (_) {}
      // Also try thumbnail
      try { await fs.promises.unlink(result.path + '.thumb'); } catch (_) {}
      // Clear photo cache
      photosCache = null;
    }
    res.json({ success: result.deleted > 0, deleted: result.deleted });
  } catch (err) {
    console.error('Delete photo error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── VLM Photo Classification Endpoints ─────────────────────────────────────

import { VLMClient } from './lib/vlm-client.js';
import { PhotoClassifier } from './lib/photo-classifier.js';
import { FileWatcher } from './lib/file-watcher.js';
import { EmbeddingClient } from './lib/embedding-client.js';
import { EmbedClassifier, EMBED_CATEGORY_PROTOTYPES, EMBED_CATEGORY_OTHER } from './lib/embed-classifier.js';
import { createJob, update as updateJob, get as getJob, getRaw as getJobRaw, list as listJobs, fail as failJob, complete as completeJob, cancel as cancelJob, isCancelled as isJobCancelled, setRunner as setJobRunner } from './lib/job-progress.js';

const vlmConfig = {
  lmstudioUrl: process.env.LMSTUDIO_URL || process.env.VLM_URL || 'http://127.0.0.1:8080',
  model: process.env.VLM_MODEL || 'qwen3.8-flash-next-iq2_xs-V-vision-128k-kv64k',
  timeout: parseInt(process.env.VLM_TIMEOUT) || 180000,
  apiKey: process.env.VLM_API_KEY || '',
  apiKeyFile: process.env.VLM_API_KEY_FILE || '',
  imageMode: process.env.VLM_IMAGE_MODE || 'openai',
  maxImageWidth: process.env.VLM_MAX_WIDTH || 384,
  jpegQuality: process.env.VLM_JPEG_QUALITY || 55
};
const embedConfig = {
  baseUrl: process.env.EMBEDDING_URL || 'http://127.0.0.1:12333',
  model: process.env.EMBEDDING_MODEL || 'embeddinggemma-2',
  timeout: parseInt(process.env.EMBEDDING_TIMEOUT) || 120000,
  dims: parseInt(process.env.EMBEDDING_DIMS) || 768
};
const embedClassifyMinScore = parseFloat(process.env.EMBED_CLASSIFY_MIN_SCORE || '0.25');


let fileWatcher = null;

// Check VLM connection status
app.get('/api/vlm/status', requireAuthWrapper, async (req, res) => {
  try {
    const client = new VLMClient(vlmConfig);
    const connected = await client.checkConnection();
    const models = connected ? await client.getAvailableModels() : [];
    res.json({
      connected,
      model: vlmConfig.model,
      lmstudioUrl: vlmConfig.lmstudioUrl,
      availableModels: models,
      watcherRunning: fileWatcher?.running || false,
      watcherStats: fileWatcher?.getStats() || null
    });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

// Classify a single image via VLM
app.post('/api/vlm/classify', requireAuthWrapper, requirePhotoPermission, async (req, res) => {
  try {
    const { filePath, outputPath } = req.body;
    if (!filePath) {
      return res.status(400).json({ error: 'filePath is required' });
    }

    const exists = await fs.promises.access(filePath).then(() => true).catch(() => false);
    if (!exists) {
      return res.status(404).json({ error: 'File not found' });
    }

    const classifier = new PhotoClassifier({
      vlm: vlmConfig,
      outputBase: outputPath || process.env.PHOTO_OUTPUT_DIR || path.join(process.cwd(), 'photo_library')
    });

    let exifData = {};
    try {
      const { exiftool: et } = await import('exiftool-vendored');
      const exif = await et.read(filePath);
      exifData = {
        datetime: { taken: exif.DateTimeOriginal || exif.CreateDate },
        location: { latitude: exif.GPSLatitude, longitude: exif.GPSLongitude }
      };
    } catch {}

    const result = await classifier.classifyAndRoute(filePath, exifData);
    res.json(result);
  } catch (err) {
    console.error('VLM classify error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Batch classify images in a directory
app.post('/api/vlm/batch-classify', requireAuthWrapper, requirePhotoPermission, async (req, res) => {
  try {
    const { directory, outputPath } = req.body;
    if (!directory) {
      return res.status(400).json({ error: 'directory is required' });
    }

    const exists = await fs.promises.access(directory).then(() => true).catch(() => false);
    if (!exists) {
      return res.status(404).json({ error: 'Directory not found' });
    }

    const classifier = new PhotoClassifier({
      vlm: vlmConfig,
      outputBase: outputPath || process.env.PHOTO_OUTPUT_DIR || path.join(process.cwd(), 'photo_library')
    });

    const result = await classifier.classifyExistingFiles(directory);
    res.json(result);
  } catch (err) {
    console.error('VLM batch classify error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get classification statistics
app.get('/api/vlm/stats', requireAuthWrapper, async (req, res) => {
  try {
    const stats = await db.getClassificationStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get classified photos with filters (including detailed vision fields)
app.get('/api/vlm/classifications', requireAuthWrapper, requirePhotoPermission, async (req, res) => {
  try {
    const { category, hasText, minConfidence, since, limit, tag, mood, style, search } = req.query;
    const filters = {};
    if (category) filters.category = category;
    if (hasText !== undefined) filters.hasText = hasText === 'true';
    if (minConfidence) filters.minConfidence = parseFloat(minConfidence);
    if (since) filters.since = since;
    if (limit) filters.limit = parseInt(limit);
    if (tag) filters.tag = tag;
    if (mood) filters.mood = mood;
    if (style) filters.style = style;
    if (search) filters.search = search;

    const results = await db.getPhotoClassifications(filters);
    res.json({ results, total: results.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search photos by AI prompt content
app.get('/api/vlm/search', requireAuthWrapper, requirePhotoPermission, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) {
      return res.status(400).json({ error: 'Query parameter q is required' });
    }
    const results = await db.searchByPrompt(q);
    res.json({ results, total: results.length, query: q });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all unique tags
app.get('/api/vlm/tags', requireAuthWrapper, async (req, res) => {
  try {
    const tags = await db.getAllTags();
    res.json({ tags, total: tags.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start file watcher
app.post('/api/vlm/watcher/start', requireAuthWrapper, async (req, res) => {
  try {
    const { watchDir, outputPath } = req.body;
    if (!watchDir) {
      return res.status(400).json({ error: 'watchDir is required' });
    }

    if (fileWatcher?.running) {
      return res.json({ status: 'already_running', stats: fileWatcher.getStats() });
    }

    fileWatcher = new FileWatcher({
      watchDir,
      outputBase: outputPath || process.env.PHOTO_OUTPUT_DIR || path.join(process.cwd(), 'photo_library'),
      vlm: vlmConfig,
      db
    });

    await fileWatcher.start();
    res.json({ status: 'started', watchDir });
  } catch (err) {
    console.error('Watcher start error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Stop file watcher
app.post('/api/vlm/watcher/stop', requireAuthWrapper, async (req, res) => {
  try {
    if (fileWatcher) {
      await fileWatcher.stop();
      const stats = fileWatcher.getStats();
      fileWatcher = null;
      res.json({ status: 'stopped', stats });
    } else {
      res.json({ status: 'not_running' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cleanup expired data (receipts/screenshots)
app.post('/api/vlm/cleanup', requireAuthWrapper, async (req, res) => {
  try {
    const { expiryDays } = req.body;
    const classifier = new PhotoClassifier({
      vlm: vlmConfig,
      outputBase: process.env.PHOTO_OUTPUT_DIR || path.join(process.cwd(), 'photo_library')
    });
    const result = await classifier.cleanupExpiredData(expiryDays || 90);
    res.json({ status: 'completed', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// === EmbeddingGemma semantic index + VLM Describe/Ask ===

app.get('/api/embed/status', requireAuthWrapper, async (req, res) => {
  try {
    const client = new EmbeddingClient(embedConfig);
    const status = await client.checkConnection();
    const count = await db.countFileEmbeddings(embedConfig.model).catch(() => 0);
    res.json({
      ...status,
      model: embedConfig.model,
      embeddingUrl: embedConfig.baseUrl,
      indexedCount: count
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- Background job runner (embed / classify / thumbs) ----
setJobRunner(async (job) => {
  const params = job.params || {};
  const type = job.type;
  const jobId = job.id;

  if (type === 'embed-folder') {
    const client = new EmbeddingClient(embedConfig);
    const conn = await client.checkConnection();
    if (!conn.ok) throw new Error(conn.error || 'Embedding server unavailable');
    const listed = await db.listImagesInFolder({
      folderId: params.folderId,
      folderPath: params.folderPath,
      limit: Math.min(parseInt(params.limit, 10) || 200, 500)
    });
    if (!listed.folderId) throw new Error('Folder not found in folder_tree. Refresh/scan first.');
    updateJob(jobId, { total: listed.files.length, message: 'Embedding images…', meta: { folderId: listed.folderId, path: listed.path } });
    const force = !!params.force;
    const results = [];
    let indexed = 0, skipped = 0, failed = 0;
    let i = 0;
    for (const file of listed.files) {
      if (isJobCancelled(jobId)) throw new Error('Cancelled');
      i++;
      const filePath = file.path;
      try {
        if (!force) {
          const existing = await db.getFileEmbedding(file.id, embedConfig.model);
          if (existing) {
            skipped++;
            results.push({ id: file.id, name: file.name, status: 'skipped' });
            updateJob(jobId, { done: i, currentItem: file.name, message: `Skip ${i}/${listed.files.length}: ${file.name}` });
            continue;
          }
        }
        const exists = await fs.promises.access(filePath).then(() => true).catch(() => false);
        if (!exists) {
          failed++;
          results.push({ id: file.id, name: file.name, status: 'missing' });
          updateJob(jobId, { done: i, currentItem: file.name, message: `Missing ${i}/${listed.files.length}` });
          continue;
        }
        const emb = await client.embedImage(filePath);
        await db.upsertFileEmbedding(file.id, {
          embedding: emb.embedding,
          model: emb.model,
          dims: emb.dims,
          sourceMtime: file.mtime || null
        });
        indexed++;
        results.push({ id: file.id, name: file.name, status: 'indexed', dims: emb.dims });
        updateJob(jobId, { done: i, currentItem: file.name, message: `Indexed ${i}/${listed.files.length}: ${file.name}` });
      } catch (err) {
        failed++;
        results.push({ id: file.id, name: file.name, status: 'error', error: err.message });
        updateJob(jobId, { done: i, currentItem: file.name, message: `Error ${i}/${listed.files.length}: ${err.message}` });
        if (err.statusCode === 503) throw err;
      }
    }
    const payload = { folderId: listed.folderId, path: listed.path, total: listed.files.length, indexed, skipped, failed, model: embedConfig.model, results };
    completeJob(jobId, payload, `Done: indexed=${indexed} skipped=${skipped} failed=${failed}`);
    return payload;
  }

  if (type === 'embed-classify-folder') {
    const threshold = Number.isFinite(Number(params.minScore)) ? Number(params.minScore) : embedClassifyMinScore;
    const classifier = new EmbedClassifier({ embedConfig, minScore: threshold });
    const conn = await classifier.client.checkConnection();
    if (!conn.ok) throw new Error(conn.error || 'Embedding server unavailable');
    const prototypes = await classifier.ensurePrototypes(db, { forceRefresh: !!params.refreshPrototypes });
    const listed = await db.listImagesInFolder({
      folderId: params.folderId,
      folderPath: params.folderPath,
      limit: Math.min(parseInt(params.limit, 10) || 500, 2000)
    });
    if (!listed.folderId) throw new Error('Folder not found in folder_tree. Refresh/scan first.');
    updateJob(jobId, { total: listed.files.length, message: 'Classifying…', meta: { folderId: listed.folderId, path: listed.path } });
    const force = !!params.force;
    const results = [];
    let classified = 0, skipped = 0, failed = 0, missingEmbed = 0;
    const categoryCounts = {};
    let i = 0;
    for (const file of listed.files) {
      if (isJobCancelled(jobId)) throw new Error('Cancelled');
      i++;
      try {
        if (!force) {
          const existing = await db.getFileEmbeddingCategory(file.id, embedConfig.model);
          if (existing) {
            skipped++;
            categoryCounts[existing.category] = (categoryCounts[existing.category] || 0) + 1;
            results.push({ id: file.id, name: file.name, status: 'skipped', category: existing.category, score: Number(existing.score) });
            updateJob(jobId, { done: i, currentItem: file.name, message: `Skip ${i}/${listed.files.length}: ${file.name}` });
            continue;
          }
        }
        const embRow = await db.getFileEmbedding(file.id, embedConfig.model);
        if (!embRow?.embedding?.length) {
          missingEmbed++; failed++;
          results.push({ id: file.id, name: file.name, status: 'missing-embedding' });
          updateJob(jobId, { done: i, currentItem: file.name, message: `No embed ${i}/${listed.files.length}` });
          continue;
        }
        const verdict = classifier.classify(embRow.embedding, prototypes);
        await db.upsertFileEmbeddingCategory(file.id, { model: embedConfig.model, category: verdict.category, score: verdict.score });
        classified++;
        categoryCounts[verdict.category] = (categoryCounts[verdict.category] || 0) + 1;
        results.push({ id: file.id, name: file.name, status: 'classified', category: verdict.category, score: Number(verdict.score.toFixed(6)) });
        updateJob(jobId, { done: i, currentItem: file.name, message: `${verdict.category} ${i}/${listed.files.length}: ${file.name}` });
      } catch (err) {
        failed++;
        results.push({ id: file.id, name: file.name, status: 'error', error: err.message });
        updateJob(jobId, { done: i, currentItem: file.name, message: `Error ${i}/${listed.files.length}: ${err.message}` });
        if (err.statusCode === 503) throw err;
      }
    }
    const payload = { folderId: listed.folderId, path: listed.path, total: listed.files.length, classified, skipped, failed, missingEmbed, minScore: threshold, model: embedConfig.model, categoryCounts, results };
    completeJob(jobId, payload, `Done: classified=${classified} skipped=${skipped} failed=${failed}`);
    return payload;
  }

  if (type === 'thumbs-folder') {
    const listed = await db.listImagesInFolder({
      folderId: params.folderId,
      folderPath: params.folderPath,
      limit: Math.min(parseInt(params.limit, 10) || 200, 500)
    });
    if (!listed.folderId) throw new Error('Folder not found in folder_tree');
    const thumbMax = Math.min(1024, Math.max(64, parseInt(params.maxSize, 10) || 400));
    updateJob(jobId, { total: listed.files.length, message: 'Warming thumbnails…', meta: { folderId: listed.folderId, path: listed.path, maxSize: thumbMax } });
    const force = !!params.force;
    let generated = 0, skipped = 0, failed = 0;
    const results = [];
    let i = 0;
    for (const file of listed.files) {
      if (isJobCancelled(jobId)) throw new Error('Cancelled');
      i++;
      const filePath = file.path;
      try {
        const [rows] = await db.connection.execute(
          'SELECT id, name, size, hash, md5, quick_hash FROM scanned_files WHERE id = ?',
          [file.id]
        );
        let row = rows[0];
        if (!row) { failed++; results.push({ id: file.id, name: file.name, status: 'missing-db' }); updateJob(jobId, { done: i, currentItem: file.name, message: `Missing DB ${i}/${listed.files.length}` }); continue; }
        if (!row.hash && !row.md5 && !row.quick_hash) {
          const computed = computeQuickHash(filePath);
          if (computed?.hash) {
            await db.connection.execute('UPDATE scanned_files SET quick_hash = ? WHERE id = ? AND quick_hash IS NULL', [computed.hash, row.id]);
            row = { ...row, quick_hash: computed.hash };
          }
        }
        const existing = await db.getThumbnailForScannedFile(row);
        if (existing && !force) {
          skipped++;
          results.push({ id: file.id, name: file.name, status: 'skipped', bytes: existing.thumb_data?.length || 0 });
          updateJob(jobId, { done: i, currentItem: file.name, message: `Skip ${i}/${listed.files.length}: ${file.name}` });
          continue;
        }
        const exists = await fs.promises.access(filePath).then(() => true).catch(() => false);
        if (!exists) { failed++; results.push({ id: file.id, name: file.name, status: 'missing' }); updateJob(jobId, { done: i, currentItem: file.name, message: `Missing ${i}/${listed.files.length}` }); continue; }
        const buf = await sharp(filePath).resize({ width: thumbMax, height: thumbMax, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer();
        const hashKey = row.hash || row.md5 || row.quick_hash;
        if (!hashKey) { failed++; results.push({ id: file.id, name: file.name, status: 'no-hash' }); updateJob(jobId, { done: i, currentItem: file.name, message: `No hash ${i}/${listed.files.length}` }); continue; }
        await db.saveThumbnail(hashKey, row.size, 'image', buf, 'image/jpeg');
        generated++;
        results.push({ id: file.id, name: file.name, status: 'generated', bytes: buf.length });
        updateJob(jobId, { done: i, currentItem: file.name, message: `Thumb ${i}/${listed.files.length}: ${file.name}` });
      } catch (err) {
        failed++;
        results.push({ id: file.id, name: file.name, status: 'error', error: err.message });
        updateJob(jobId, { done: i, currentItem: file.name, message: `Error ${i}/${listed.files.length}: ${err.message}` });
      }
    }
    const payload = { folderId: listed.folderId, path: listed.path, total: listed.files.length, generated, skipped, failed, maxSize: thumbMax, results };
    completeJob(jobId, payload, `Done: generated=${generated} skipped=${skipped} failed=${failed}`);
    return payload;
  }

  throw new Error('Unknown job type: ' + type);
});

// Non-recursive: index images in one selected folder into file_embeddings
app.post('/api/embed/folder', requireAuthWrapper, requirePhotoPermission, async (req, res) => {
  try {
    const { folderPath, folderId, limit = 200, force = false } = req.body || {};
    if (!folderPath && !folderId) {
      return res.status(400).json({ error: 'folderPath or folderId is required' });
    }
    const client = new EmbeddingClient(embedConfig);
    const conn = await client.checkConnection();
    if (!conn.ok) {
      return res.status(503).json({
        error: 'Embedding server unavailable',
        detail: conn.error || 'Cannot reach EMBEDDING_URL',
        embeddingUrl: embedConfig.baseUrl,
        hint: 'Start llama-server with EmbeddingGemma 2 GGUF + mmproj and --embeddings (see AGENTS.md)'
      });
    }
    const jobId = createJob({
      type: 'embed-folder',
      total: 0,
      meta: { folderId: folderId || null, folderPath: folderPath || null },
      params: { folderId, folderPath, limit, force: !!force },
      createdBy: req.user?.username || req.user?.id || null
    });
    res.status(202).json({ jobId, status: 'queued', type: 'embed-folder', reviewUrl: '/jobs?id=' + jobId });
  } catch (err) {
    console.error('embed/folder error:', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});


// Resolve optional DB thumbnail for VLM (thumbnail_cache via hash+size). Falls back to disk.
async function resolveVlmImageOptions(filePath, body = {}) {
  const useThumbnail = body.useThumbnail !== false && body.useThumbnail !== 0 && body.useThumbnail !== '0' && body.useThumbnail !== 'false';
  const opts = {
    maxWidth: body.maxWidth,
    size: body.size,
    useThumbnail
  };
  if (!useThumbnail) return opts;

  try {
    const scanned = await db.getScannedFileByPath(filePath);
    if (!scanned) return opts;

    let file = scanned;
    // Ensure we have a hash key for thumbnail_cache
    if (!file.hash && !file.md5 && !file.quick_hash) {
      const computed = computeQuickHash(filePath);
      if (computed?.hash) {
        await db.connection.execute(
          'UPDATE scanned_files SET quick_hash = ? WHERE id = ? AND quick_hash IS NULL',
          [computed.hash, scanned.id]
        ).catch(() => {});
        file = { ...file, quick_hash: computed.hash, size: computed.size || file.size };
      }
    }

    let thumb = await db.getThumbnailForScannedFile(file);
    if (!thumb) {
      // Generate + cache using same pipeline as /images/:id/thumb (400px JPEG)
      const result = await sharp(filePath)
        .resize({ width: 400, height: 400, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 75 })
        .toBuffer({ resolveWithObject: true });
      const hashKey = file.hash || file.md5 || file.quick_hash;
      if (hashKey) {
        await db.saveThumbnail(hashKey, file.size, 'image', result.data, 'image/jpeg');
        thumb = { thumb_data: result.data, content_type: 'image/jpeg', file_hash: hashKey, file_size: file.size };
      } else {
        opts.imageBuffer = result.data;
        opts.originalSize = file.size;
        opts.source = 'generated-no-hash';
        return opts;
      }
    }

    if (thumb?.thumb_data) {
      opts.imageBuffer = Buffer.isBuffer(thumb.thumb_data) ? thumb.thumb_data : Buffer.from(thumb.thumb_data);
      opts.originalSize = file.size;
      opts.source = 'thumbnail_cache';
    }
  } catch (err) {
    console.warn('resolveVlmImageOptions thumb fallback:', err.message);
  }
  return opts;
}

// Describe selected image via VLM and write photo_classifications
app.post('/api/vlm/describe', requireAuthWrapper, requirePhotoPermission, async (req, res) => {
  try {
    const { filePath, mode = 'fast', maxWidth, size, useThumbnail } = req.body || {};
    if (!filePath) return res.status(400).json({ error: 'filePath is required' });

    const exists = await fs.promises.access(filePath).then(() => true).catch(() => false);
    if (!exists) return res.status(404).json({ error: 'File not found on disk' });

    const scanned = await db.getScannedFileByPath(filePath);
    if (!scanned) {
      return res.status(404).json({
        error: 'File not in scanned_files DB. Refresh/scan this folder first.'
      });
    }

    const client = new VLMClient(vlmConfig);
    const connected = await client.checkConnection();
    if (!connected) {
      return res.status(503).json({
        error: 'VLM server unavailable',
        lmstudioUrl: vlmConfig.lmstudioUrl,
        model: vlmConfig.model
      });
    }

    const imgOpts = await resolveVlmImageOptions(filePath, { maxWidth, size, useThumbnail });
    const vlmResult = await client.classifyImage(filePath, mode === 'detail' ? 'detail' : 'fast', imgOpts);
    if (!vlmResult.success) {
      return res.status(502).json({ error: vlmResult.error || 'VLM classify failed' });
    }

    await db.replacePhotoClassification(scanned.id, vlmResult.classification, {
      originalPath: filePath,
      destinationPath: null,
      compressed: false,
      originalSize: vlmResult.imageInfo?.originalSize || scanned.size,
      finalSize: null,
      model: vlmResult.model,
      rawResponse: vlmResult.rawResponse
    });

    res.json({
      success: true,
      fileId: scanned.id,
      path: filePath,
      classification: vlmResult.classification,
      model: vlmResult.model,
      mode: vlmResult.mode,
      imageInfo: vlmResult.imageInfo || null,
      saved: true
    });
  } catch (err) {
    console.error('vlm/describe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Ask chat about a selected image (optional history); does not auto-save
app.post('/api/vlm/ask', requireAuthWrapper, requirePhotoPermission, async (req, res) => {
  try {
    const { filePath, question, history = [], maxWidth, size, useThumbnail } = req.body || {};
    if (!filePath) return res.status(400).json({ error: 'filePath is required' });
    if (!question) return res.status(400).json({ error: 'question is required' });

    const exists = await fs.promises.access(filePath).then(() => true).catch(() => false);
    if (!exists) return res.status(404).json({ error: 'File not found on disk' });

    const client = new VLMClient(vlmConfig);
    const connected = await client.checkConnection();
    if (!connected) {
      return res.status(503).json({
        error: 'VLM server unavailable',
        lmstudioUrl: vlmConfig.lmstudioUrl,
        model: vlmConfig.model
      });
    }

    const imgOpts = await resolveVlmImageOptions(filePath, { maxWidth, size, useThumbnail });
    const result = await client.askAboutImage(filePath, question, history, imgOpts);
    if (!result.success) {
      return res.status(502).json({ error: result.error || 'VLM ask failed' });
    }

    res.json({
      success: true,
      answer: result.answer,
      model: result.model,
      path: filePath,
      imageInfo: result.imageInfo || null
    });
  } catch (err) {
    console.error('vlm/ask error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// List embeddings for one folder (review UI)
app.get('/api/embed/folder', requireAuthWrapper, requirePhotoPermission, async (req, res) => {
  try {
    const folderId = req.query.folderId || req.query.id || null;
    const folderPath = req.query.folderPath || req.query.path || null;
    const model = req.query.model || null;
    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 2000);
    if (!folderId && !folderPath) {
      return res.status(400).json({ error: 'folderId or folderPath is required' });
    }
    const result = await db.listFileEmbeddingsInFolder({ folderId, folderPath, model, limit });
    if (!result.folderId) {
      return res.status(404).json({ error: 'Folder not found in folder_tree' });
    }
    res.json(result);
  } catch (err) {
    console.error('embed/folder GET error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// List embedding category prototypes (text centroids)
app.get('/api/embed/categories', requireAuthWrapper, requirePhotoPermission, async (req, res) => {
  try {
    const model = req.query.model || embedConfig.model;
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const classifier = new EmbedClassifier({ embedConfig, minScore: embedClassifyMinScore });
    if (refresh) {
      const conn = await classifier.client.checkConnection();
      if (!conn.ok) {
        return res.status(503).json({
          error: 'Embedding server unavailable',
          detail: conn.error,
          embeddingUrl: embedConfig.baseUrl
        });
      }
      await classifier.ensurePrototypes(db, { forceRefresh: true });
    }
    let rows = await db.listEmbeddingCategoryPrototypes(model);
    if (!rows.length) {
      const conn = await classifier.client.checkConnection();
      if (!conn.ok) {
        return res.status(503).json({
          error: 'Embedding server unavailable (need to build prototypes)',
          detail: conn.error,
          embeddingUrl: embedConfig.baseUrl
        });
      }
      await classifier.ensurePrototypes(db, { forceRefresh: false });
      rows = await db.listEmbeddingCategoryPrototypes(model);
    }
    res.json({
      model,
      minScore: embedClassifyMinScore,
      otherLabel: EMBED_CATEGORY_OTHER,
      labels: EMBED_CATEGORY_PROTOTYPES.map(p => p.label).concat([EMBED_CATEGORY_OTHER]),
      prototypes: rows.map(r => ({
        label: r.label,
        model: r.model,
        dims: r.dims,
        promptText: r.prompt_text,
        updatedAt: r.updated_at
      }))
    });
  } catch (err) {
    console.error('embed/categories error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Classify file_embeddings in one folder via text-prototype cosine similarity
app.post('/api/embed/classify-folder', requireAuthWrapper, requirePhotoPermission, async (req, res) => {
  try {
    const { folderPath, folderId, force = false, refreshPrototypes = false, minScore, limit } = req.body || {};
    if (!folderPath && !folderId) {
      return res.status(400).json({ error: 'folderPath or folderId is required' });
    }
    const classifier = new EmbedClassifier({ embedConfig, minScore: embedClassifyMinScore });
    const conn = await classifier.client.checkConnection();
    if (!conn.ok) {
      return res.status(503).json({
        error: 'Embedding server unavailable',
        detail: conn.error || 'Cannot reach EMBEDDING_URL',
        embeddingUrl: embedConfig.baseUrl,
        hint: 'Start llama-server EmbeddingGemma with --embeddings (see AGENTS.md)'
      });
    }
    const jobId = createJob({
      type: 'embed-classify-folder',
      total: 0,
      meta: { folderId: folderId || null, folderPath: folderPath || null },
      params: { folderId, folderPath, force: !!force, refreshPrototypes: !!refreshPrototypes, minScore, limit },
      createdBy: req.user?.username || req.user?.id || null
    });
    res.status(202).json({ jobId, status: 'queued', type: 'embed-classify-folder', reviewUrl: '/jobs?id=' + jobId });
  } catch (err) {
    console.error('embed/classify-folder error:', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});


// Warm thumbnail_cache for images in one folder (non-recursive)
app.post('/api/thumbs/folder', requireAuthWrapper, requirePhotoPermission, async (req, res) => {
  try {
    const { folderPath, folderId, limit = 200, force = false, maxSize = 400 } = req.body || {};
    if (!folderPath && !folderId) {
      return res.status(400).json({ error: 'folderPath or folderId is required' });
    }
    const jobId = createJob({
      type: 'thumbs-folder',
      total: 0,
      meta: { folderId: folderId || null, folderPath: folderPath || null },
      params: { folderId, folderPath, limit, force: !!force, maxSize },
      createdBy: req.user?.username || req.user?.id || null
    });
    res.status(202).json({ jobId, status: 'queued', type: 'thumbs-folder', reviewUrl: '/jobs?id=' + jobId });
  } catch (err) {
    console.error('thumbs/folder error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get all music tracks with optional search and filters
app.get('/api/music', requireAuthWrapper, requireMusicPermission, async (req, res) => {
  try {
    const { search, filter } = req.query;
    
    const now = Date.now();
    let tracks;
    if (musicCache && (now - musicCacheTime) < MUSIC_CACHE_DURATION) {
      tracks = musicCache;
    } else {
      tracks = await db.getMusicWithMetadata();
      musicCache = tracks;
      musicCacheTime = now;
    }
    
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
app.get('/api/movies', requireAuthWrapper, requireVideoPermission, async (req, res) => {
  try {
    const { search, filter } = req.query;
    
    const now = Date.now();
    let movies;
    if (moviesCache && (now - moviesCacheTime) < MOVIES_CACHE_DURATION) {
      movies = moviesCache;
    } else {
      movies = await db.getVideosWithMetadata();
      moviesCache = movies;
      moviesCacheTime = now;
    }
    
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
app.get('/api/music/artists', requireAuthWrapper, async (req, res) => {
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
app.get('/api/music/albums', requireAuthWrapper, async (req, res) => {
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
app.get('/api/music/artist/:name', requireAuthWrapper, async (req, res) => {
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
app.get('/api/music/album/:name', requireAuthWrapper, async (req, res) => {
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
app.post('/api/history/play', requireAuthWrapper, async (req, res) => {
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
app.post('/api/music/rating', requireAuthWrapper, async (req, res) => {
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
app.get('/api/history/play', requireAuthWrapper, async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 100;
    
    const history = await authManager.getPlayHistory(userId, limit);
    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/music/rating/:fileId', requireAuthWrapper, async (req, res) => {
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
app.get('/api/history/login', requireAuthWrapper, async (req, res) => {
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
app.get('/api/music/my-ratings', requireAuthWrapper, async (req, res) => {
  try {
    const ratings = await db.getUserRatings(req.user.id);
    res.json(ratings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Music play history endpoints
app.post('/api/music/play', requireAuthWrapper, async (req, res) => {
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
app.get('/api/music/my-plays', requireAuthWrapper, async (req, res) => {
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

// Serve face groups page
app.get('/faces', (req, res) => {
  const html = fs.readFileSync(join(__dirname, 'public', 'faces.html'), 'utf8');
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

// ==================== DRIVE USAGE HISTORY ====================

async function checkDriveUsage() {
  try {
    if (!db || !db.connection) return;
    const { stdout: output, stderr } = await execFileAsync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,DriveType,Size,FreeSpace | ConvertTo-Json`
    ], { timeout: 30000 });
    const cleaned = output.replace(/^\uFEFF/, '').trim();
    if (!cleaned) {
      console.warn('Drive usage: empty output from PowerShell', stderr ? stderr.substring(0, 200) : '');
      return;
    }
    let parsed = JSON.parse(cleaned);
    let drives = Array.isArray(parsed) ? parsed : [parsed];
    const fixedDrives = drives.filter(d => d && d.DriveType === 3 && d.DeviceID);
    for (const d of fixedDrives) {
      const drive = d.DeviceID;
      const totalBytes = parseInt(d.Size) || 0;
      const freeBytes = parseInt(d.FreeSpace) || 0;
      const usedBytes = totalBytes - freeBytes;
      if (totalBytes > 0) {
        await db.recordDriveUsage(drive, totalBytes, usedBytes, freeBytes);
      }
    }
    console.log(`⏱️ Drive usage recorded: ${fixedDrives.length} drives`);
  } catch (err) {
    console.error('Drive usage check failed:', err.message);
  }
}

function startDriveUsageJob() {
  checkDriveUsage();
  setInterval(checkDriveUsage, 60 * 60 * 1000);
  console.log('⏱️ Drive usage job started (every hour)');
}

app.get('/api/drive-usage', requireAuthWrapper, async (req, res) => {
  try {
    const { drive, days } = req.query;
    const history = await db.getDriveUsageHistory(drive || null, parseInt(days) || 30);
    const latest = await db.getLatestDriveUsage();
    res.json({ latest, history });
  } catch (err) {
    console.error('Drive usage API error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/drive-usage/check', requireAuthWrapper, async (req, res) => {
  try {
    await checkDriveUsage();
    const latest = await db.getLatestDriveUsage();
    res.json({ success: true, latest });
  } catch (err) {
    console.error('Drive usage check API error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================== FACE GROUPING APIs ====================

function hammingHash(h1, h2) {
  let xor = BigInt(h1) ^ BigInt(h2);
  let c = 0;
  while (xor) { c++; xor &= xor - 1n; }
  return c;
}

// Get face groups (server-side grouped, paginated)
app.get('/api/faces/groups', requireAuthWrapper, requirePhotoPermission, async (req, res) => {
  try {
    const { limit = 100, offset = 0, named } = req.query;

    // Get groups from face_groups table
    let groupQuery = 'SELECT * FROM face_groups';
    const groupParams = [];
    if (named === '1') {
      groupQuery += ' WHERE label IS NOT NULL AND label != ""';
    } else if (named === '0') {
      groupQuery += ' WHERE label IS NULL OR label = ""';
    }
    groupQuery += ` ORDER BY face_count DESC LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}`;

    const [dbGroups] = await db.connection.execute(groupQuery, groupParams);
    const [totalCount] = await db.connection.execute(
      named === '1' ? 'SELECT COUNT(*) as c FROM face_groups WHERE label IS NOT NULL AND label != ""' :
      named === '0' ? 'SELECT COUNT(*) as c FROM face_groups WHERE label IS NULL OR label = ""' :
      'SELECT COUNT(*) as c FROM face_groups'
    );

    // For each group, get its faces
        const groups = [];
        for (const grp of dbGroups) {
          // Get TOTAL file count (unique files in this group from faces_v2)
          const [fileCountResult] = await db.connection.execute(`
            SELECT COUNT(DISTINCT file_id) as cnt FROM faces_v2
            WHERE face_group_id = ? AND (status IS NULL OR status != 'ignored')
          `, [grp.id]);
          const totalFileCount = fileCountResult[0]?.cnt || 0;

          // Get TOTAL face count for this group
          const [faceCountResult] = await db.connection.execute(`
            SELECT COUNT(*) as cnt FROM faces_v2
            WHERE face_group_id = ? AND (status IS NULL OR status != 'ignored')
          `, [grp.id]);
          const totalFaceCount = faceCountResult[0]?.cnt || 0;

          // Get sample of faces (for thumbnails and master face lookup only - limit 20)
          const [faces] = await db.connection.execute(`
            SELECT fv.id, fv.file_id, fv.face_index, fv.confidence, fv.gender, fv.age,
                   fv.thumbnail, sf.name
            FROM faces_v2 fv
            JOIN scanned_files sf ON fv.file_id = sf.id
            WHERE fv.face_group_id = ? AND (fv.status IS NULL OR fv.status != 'ignored')
            ORDER BY fv.confidence DESC
            LIMIT 20
          `, [grp.id]);

          const parsedFaces = faces.map(f => {
            let thumb = null;
            if (f.thumbnail) {
              try { thumb = Buffer.isBuffer(f.thumbnail) ? f.thumbnail.toString('base64') : Buffer.from(f.thumbnail).toString('base64'); } catch {}
            }
            return { ...f, thumb };
          });

          let masterThumb = null;
          if (grp.master_face_id) {
            const mf = parsedFaces.find(f => f.id === grp.master_face_id);
            if (mf) masterThumb = mf.thumb;
            if (!masterThumb) {
              const [mrow] = await db.connection.execute(`
                SELECT fv.thumbnail FROM faces_v2 fv WHERE fv.id = ?
              `, [grp.master_face_id]);
          if (mrow.length > 0) {
            try { masterThumb = Buffer.isBuffer(mrow[0].thumbnail) ? mrow[0].thumbnail.toString('base64') : Buffer.from(mrow[0].thumbnail).toString('base64'); } catch {}
          }
        }
      }

      // Get dominant gender from ALL faces_v2 records, not just sampled ones
      const [genderResult] = await db.connection.execute(`
        SELECT gender, COUNT(*) as c FROM faces_v2
        WHERE face_group_id = ? AND gender IS NOT NULL AND gender NOT IN ('', 'unknown')
        GROUP BY gender ORDER BY c DESC LIMIT 1
      `, [grp.id]);
      const dominantGender = genderResult.length > 0 ? genderResult[0].gender : 'unknown';

      const files = [...new Set(parsedFaces.map(f => f.name))];
      const genderCount = {};
      for (const f of parsedFaces) { if (f.gender) genderCount[f.gender] = (genderCount[f.gender] || 0) + 1; }

      groups.push({
              id: grp.id,
              label: grp.label,
              faceCount: totalFaceCount,
              fileCount: totalFileCount,
              photoCount: totalFileCount,
              dominantGender,
              files,  // Array of sample filenames (up to 20)
              masterThumb,
              groupType: grp.group_type || 'unknown',
              relationship: grp.relationship || null,
              birthYear: grp.birth_year || null,
              faces: parsedFaces
            });
          }

    res.json({ groups, total: totalCount[0].c, limit: parseInt(limit), offset: parseInt(offset) });
  } catch (err) {
    console.error('Face groups error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get ignored faces
app.get('/api/faces/ignored', requireAuthWrapper, requirePhotoPermission, async (req, res) => {
  try {
    const { limit = 100, offset = 0, type } = req.query;
    let whereClause = "df.all_expressions IS NOT NULL AND JSON_EXTRACT(df.all_expressions, '$.invalid') = true";
    const params = [];
    if (type) {
      whereClause += " AND JSON_EXTRACT(df.all_expressions, '$.ignore_type') = ?";
      params.push(type);
    }
    const [faces] = await db.connection.execute(`
      SELECT df.id, df.file_id, df.face_index, df.confidence, df.gender, df.age, df.expression,
             df.all_expressions, df.face_descriptor, sf.name
      FROM detected_faces df
      JOIN scanned_files sf ON df.file_id = sf.id
      WHERE ${whereClause}
      ORDER BY df.file_id DESC
      LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
    `, params);

    const [total] = await db.connection.execute(
      `SELECT COUNT(*) as c FROM detected_faces df WHERE ${whereClause}`, params
    );

    const parsed = faces.map(f => {
      const desc = typeof f.face_descriptor === 'string' ? JSON.parse(f.face_descriptor) : (f.face_descriptor || {});
      let ignoreType = 'unknown_face';
      try {
        const ae = typeof f.all_expressions === 'string' ? JSON.parse(f.all_expressions) : f.all_expressions;
        ignoreType = ae?.ignore_type || 'unknown_face';
      } catch {}
      return { ...f, thumb: desc?.thumbnail, phash: desc?.phash, ignoreType };
    });

    res.json({ faces: parsed, total: total[0].c });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get faces not yet grouped (orphan faces)
// Auto-group faces into existing groups using embeddings

// Auto-group faces into existing groups using embeddings

// Auto-group faces into existing groups using embeddings

app.get('/api/faces/unassigned', requireAuthWrapper, requirePhotoPermission, async (req, res) => {
  try {
    const { limit = 100, offset = 0, minConfidence = 0 } = req.query;
    const [faces] = await db.connection.execute(`
      SELECT df.id, df.file_id, df.face_index, df.confidence, df.gender, df.age, df.expression,
             df.face_descriptor, sf.name
      FROM detected_faces df
      JOIN scanned_files sf ON df.file_id = sf.id
      WHERE df.face_group_id IS NULL
      AND df.face_descriptor IS NOT NULL
      AND (df.all_expressions IS NULL OR JSON_EXTRACT(df.all_expressions, '$.invalid') IS NULL OR JSON_EXTRACT(df.all_expressions, '$.invalid') = false)
      AND df.confidence >= ?
      ORDER BY sf.ctime
      LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
    `, [parseFloat(minConfidence)]);

    const [total] = await db.connection.execute(
      'SELECT COUNT(*) as c FROM detected_faces WHERE face_group_id IS NULL AND face_descriptor IS NOT NULL AND (all_expressions IS NULL OR JSON_EXTRACT(all_expressions, "$.invalid") IS NULL OR JSON_EXTRACT(all_expressions, "$.invalid") = false) AND confidence >= ?',
      [parseFloat(minConfidence)]
    );

    const parsed = faces.map(f => {
      const desc = typeof f.face_descriptor === 'string' ? JSON.parse(f.face_descriptor) : (f.face_descriptor || {});
      return { ...f, thumb: desc?.thumbnail, phash: desc?.phash, has_glasses: desc?.has_glasses };
    });

    // Auto-group by phash similarity
    const groups = [];
    const assigned = new Set();
    for (let i = 0; i < parsed.length; i++) {
      if (assigned.has(i)) continue;
      const a = parsed[i];
      if (!a.phash) continue;
      const group = { faces: [a] };
      assigned.add(i);
      for (let j = i + 1; j < parsed.length; j++) {
        if (assigned.has(j)) continue;
        const b = parsed[j];
        if (!b.phash) continue;
        if (hammingHash(a.phash, b.phash) <= 10) {
          group.faces.push(b);
          assigned.add(j);
        }
      }
      group.faceCount = group.faces.length;
      group.files = [...new Set(group.faces.map(f => f.name))];
      groups.push(group);
    }
    groups.sort((a, b) => b.faceCount - a.faceCount);

    res.json({ groups, totalUnassigned: total[0].c });
  } catch (err) {
    console.error('Unassigned faces error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get single face group detail
app.get('/api/faces/groups/:groupId', requireAuthWrapper, requirePhotoPermission, async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const [grp] = await db.connection.execute('SELECT * FROM face_groups WHERE id = ?', [groupId]);
    if (grp.length === 0) return res.status(404).json({ error: 'Group not found' });

    const [faces] = await db.connection.execute(`
      SELECT df.id, df.file_id, df.face_index, df.confidence, df.gender, df.age, df.expression,
             df.face_descriptor, sf.name
      FROM detected_faces df
      JOIN scanned_files sf ON df.file_id = sf.id
      WHERE df.face_group_id = ?
      ORDER BY df.confidence DESC
    `, [groupId]);

    const parsedFaces = faces.map(f => {
      const desc = typeof f.face_descriptor === 'string' ? JSON.parse(f.face_descriptor) : (f.face_descriptor || {});
      return { ...f, thumb: desc?.thumbnail, phash: desc?.phash, has_glasses: desc?.has_glasses, age_group: desc?.age_group };
    });

    res.json({ group: { ...grp[0], groupType: grp[0].group_type, relationship: grp[0].relationship, faces: parsedFaces, files: [...new Set(parsedFaces.map(f => f.name))] } });
  } catch (err) {
    console.error('Face group detail error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Create new face group
app.post('/api/faces/groups', requireAuthWrapper, async (req, res) => {
  try {
    const { label } = req.body;
    const [result] = await db.connection.execute('INSERT INTO face_groups (label) VALUES (?)', [label || null]);
    res.json({ success: true, groupId: result.insertId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rename a face group
app.put('/api/faces/groups/:groupId', requireAuthWrapper, async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const { label, groupType, relationship, birthYear } = req.body;
    if (label !== undefined) {
      await db.connection.execute('UPDATE face_groups SET label = ? WHERE id = ?', [label, groupId]);
    }
    if (groupType !== undefined) {
      await db.connection.execute('UPDATE face_groups SET group_type = ? WHERE id = ?', [groupType || 'unknown', groupId]);
    }
    if (relationship !== undefined) {
      await db.connection.execute('UPDATE face_groups SET relationship = ? WHERE id = ?', [relationship || null, groupId]);
    }
    if (birthYear !== undefined) {
      await db.connection.execute('UPDATE face_groups SET birth_year = ? WHERE id = ?', [birthYear || null, groupId]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set master photo for a face group
app.post('/api/faces/groups/:groupId/master', requireAuthWrapper, async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const { faceId } = req.body;

    if (faceId) {
      const [face] = await db.connection.execute('SELECT id FROM detected_faces WHERE id = ? AND face_group_id = ?', [faceId, groupId]);
      if (face.length === 0) return res.status(404).json({ error: 'Face not found in this group' });
    }

    await db.connection.execute('UPDATE face_groups SET master_face_id = ? WHERE id = ?', [faceId || null, groupId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get master photo for a face group
app.get('/api/faces/groups/:groupId/master', requireAuthWrapper, async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const [grp] = await db.connection.execute('SELECT master_face_id FROM face_groups WHERE id = ?', [groupId]);
    if (grp.length === 0 || !grp[0].master_face_id) return res.json({ master: null });

    const [face] = await db.connection.execute(`
      SELECT df.id, df.file_id, df.face_descriptor, df.confidence, df.gender, df.age
      FROM detected_faces df WHERE df.id = ?
    `, [grp[0].master_face_id]);

    if (face.length === 0) return res.json({ master: null });

    const desc = typeof face[0].face_descriptor === 'string' ? JSON.parse(face[0].face_descriptor) : face[0].face_descriptor;
    res.json({ master: { ...face[0], thumb: desc?.thumbnail, phash: desc?.phash, dhash: desc?.dhash } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get secondary reference photos for a face group
app.get('/api/faces/groups/:groupId/secondary', requireAuthWrapper, async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const [grp] = await db.connection.execute('SELECT secondary_face_ids FROM face_groups WHERE id = ?', [groupId]);
    if (grp.length === 0) return res.json({ secondary: [] });

    const ids = grp[0].secondary_face_ids ? JSON.parse(grp[0].secondary_face_ids) : [];
    if (!ids.length) return res.json({ secondary: [] });

    const placeholders = ids.map(() => '?').join(',');
    const [faces] = await db.connection.execute(`
      SELECT df.id, df.file_id, df.confidence, df.gender, df.age, df.face_descriptor, sf.name
      FROM detected_faces df
      JOIN scanned_files sf ON df.file_id = sf.id
      WHERE df.id IN (${placeholders})
    `, ids);

    const parsed = faces.map(f => {
      const desc = typeof f.face_descriptor === 'string' ? JSON.parse(f.face_descriptor) : (f.face_descriptor || {});
      return { id: f.id, fileId: f.file_id, thumb: desc?.thumbnail, phash: desc?.phash, gender: f.gender, age: f.age, fileName: f.name };
    });

    res.json({ secondary: parsed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set secondary reference photos for a face group (replaces all)
app.post('/api/faces/groups/:groupId/secondary', requireAuthWrapper, async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const { faceIds } = req.body;

    if (!Array.isArray(faceIds) || faceIds.length > 5) {
      return res.status(400).json({ error: 'faceIds array required, max 5' });
    }

    for (const faceId of faceIds) {
      const [face] = await db.connection.execute('SELECT id FROM detected_faces WHERE id = ? AND face_group_id = ?', [faceId, groupId]);
      if (face.length === 0) return res.status(404).json({ error: `Face ${faceId} not found in this group` });
    }

    await db.connection.execute('UPDATE face_groups SET secondary_face_ids = ? WHERE id = ?', [
      faceIds.length ? JSON.stringify(faceIds) : null, groupId
    ]);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add a single face to secondary references
app.post('/api/faces/groups/:groupId/secondary/add', requireAuthWrapper, async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const { faceId } = req.body;

    const [face] = await db.connection.execute('SELECT id FROM detected_faces WHERE id = ? AND face_group_id = ?', [faceId, groupId]);
    if (face.length === 0) return res.status(404).json({ error: 'Face not found in this group' });

    const [grp] = await db.connection.execute('SELECT secondary_face_ids FROM face_groups WHERE id = ?', [groupId]);
    const ids = grp[0]?.secondary_face_ids ? JSON.parse(grp[0].secondary_face_ids) : [];

    if (ids.includes(faceId)) return res.json({ success: true, message: 'Already added' });
    if (ids.length >= 5) return res.status(400).json({ error: 'Maximum 5 secondary images reached' });

    ids.push(faceId);
    await db.connection.execute('UPDATE face_groups SET secondary_face_ids = ? WHERE id = ?', [JSON.stringify(ids), groupId]);

    res.json({ success: true, count: ids.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove a face from secondary references
app.post('/api/faces/groups/:groupId/secondary/remove', requireAuthWrapper, async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const { faceId } = req.body;

    const [grp] = await db.connection.execute('SELECT secondary_face_ids FROM face_groups WHERE id = ?', [groupId]);
    let ids = grp[0]?.secondary_face_ids ? JSON.parse(grp[0].secondary_face_ids) : [];

    ids = ids.filter(id => id !== faceId);
    await db.connection.execute('UPDATE face_groups SET secondary_face_ids = ? WHERE id = ?', [
      ids.length ? JSON.stringify(ids) : null, groupId
    ]);

    res.json({ success: true, count: ids.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Assign faces to a group
app.post('/api/faces/groups/:groupId/assign', requireAuthWrapper, async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const { faceIds } = req.body;
    if (!Array.isArray(faceIds)) return res.status(400).json({ error: 'faceIds array required' });

    for (const faceId of faceIds) {
      await db.connection.execute('UPDATE detected_faces SET face_group_id = ? WHERE id = ?', [groupId, faceId]);
    }

    // Update face_count
    const [count] = await db.connection.execute('SELECT COUNT(*) as c FROM detected_faces WHERE face_group_id = ?', [groupId]);
    await db.connection.execute('UPDATE face_groups SET face_count = ? WHERE id = ?', [count[0].c, groupId]);

    res.json({ success: true, faceCount: count[0].c });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove faces from group
app.post('/api/faces/groups/:groupId/unassign', requireAuthWrapper, async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const { faceIds } = req.body;
    if (!Array.isArray(faceIds)) return res.status(400).json({ error: 'faceIds array required' });

    for (const faceId of faceIds) {
      await db.connection.execute('UPDATE detected_faces SET face_group_id = NULL WHERE id = ? AND face_group_id = ?', [faceId, groupId]);
    }

    const [count] = await db.connection.execute('SELECT COUNT(*) as c FROM detected_faces WHERE face_group_id = ?', [groupId]);
    await db.connection.execute('UPDATE face_groups SET face_count = ? WHERE id = ?', [count[0].c, groupId]);

    res.json({ success: true, faceCount: count[0].c });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a face group
app.delete('/api/faces/groups/:groupId', requireAuthWrapper, async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    await db.connection.execute('UPDATE detected_faces SET face_group_id = NULL WHERE face_group_id = ?', [groupId]);
    await db.connection.execute('DELETE FROM face_groups WHERE id = ?', [groupId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark face as invalid (not a real face)
app.put('/api/faces/:faceId/invalid', requireAuthWrapper, async (req, res) => {
  try {
    const faceId = parseInt(req.params.faceId);
    const { invalid, ignoreType } = req.body;
    const [rows] = await db.connection.execute('SELECT all_expressions FROM detected_faces WHERE id = ?', [faceId]);
    if (rows.length === 0) return res.status(404).json({ error: 'Face not found' });
    let meta = {};
    try { meta = typeof rows[0].all_expressions === 'string' ? JSON.parse(rows[0].all_expressions) : (rows[0].all_expressions || {}); } catch {}
    if (invalid === false) {
      meta.invalid = false;
      meta.ignore_type = null;
    } else if (ignoreType) {
      meta.invalid = true;
      meta.ignore_type = ignoreType;
    } else {
      meta.invalid = !!invalid;
      meta.ignore_type = invalid ? (meta.ignore_type || 'unknown_face') : null;
    }
    await db.connection.execute('UPDATE detected_faces SET all_expressions = ? WHERE id = ?', [JSON.stringify(meta), faceId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark multiple faces as ignored with type
app.post('/api/faces/ignore', requireAuthWrapper, async (req, res) => {
  try {
    const { faceIds, ignoreType = 'unknown_face' } = req.body;
    if (!Array.isArray(faceIds)) return res.status(400).json({ error: 'faceIds array required' });
    for (const faceId of faceIds) {
      const [rows] = await db.connection.execute('SELECT all_expressions FROM detected_faces WHERE id = ?', [faceId]);
      if (rows.length === 0) continue;
      let meta = {};
      try { meta = typeof rows[0].all_expressions === 'string' ? JSON.parse(rows[0].all_expressions) : (rows[0].all_expressions || {}); } catch {}
      meta.invalid = true;
      meta.ignore_type = ignoreType;
      await db.connection.execute('UPDATE detected_faces SET all_expressions = ? WHERE id = ?', [JSON.stringify(meta), faceId]);
    }
    res.json({ success: true, ignored: faceIds.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update face gender/age/expression
app.put('/api/faces/:faceId', requireAuthWrapper, async (req, res) => {
  try {
    const faceId = parseInt(req.params.faceId);
    const { gender, age, expression } = req.body;
    if (gender !== undefined) {
      await db.connection.execute('UPDATE detected_faces SET gender = ? WHERE id = ?',
        [gender === 'male' || gender === 'female' ? gender : null, faceId]);
    }
    if (age !== undefined) {
      await db.connection.execute('UPDATE detected_faces SET age = ? WHERE id = ?', [age, faceId]);
    }
    if (expression !== undefined) {
      await db.connection.execute('UPDATE detected_faces SET expression = ? WHERE id = ?', [expression, faceId]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get faces for a specific photo (by file_id)
app.get('/api/faces/by-file/:fileId', requireAuthWrapper, requirePhotoPermission, async (req, res) => {
  try {
    const fileId = parseInt(req.params.fileId);
    const [faces] = await db.connection.execute(`
      SELECT df.id, df.face_index, df.confidence, df.gender, df.age, df.expression,
             df.face_descriptor, df.face_group_id,
             fg.label as group_label
      FROM detected_faces df
      LEFT JOIN face_groups fg ON df.face_group_id = fg.id
      WHERE df.file_id = ?
      ORDER BY df.face_index
    `, [fileId]);

    const parsed = faces.map(f => {
      const desc = typeof f.face_descriptor === 'string' ? JSON.parse(f.face_descriptor) : (f.face_descriptor || {});
      return { ...f, thumb: desc?.thumbnail, phash: desc?.phash, has_glasses: desc?.has_glasses, age_group: desc?.age_group };
    });

    res.json({ faces: parsed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all named groups for filter dropdown
app.get('/api/faces/named-list', requireAuthWrapper, async (req, res) => {
  try {
    const [groups] = await db.connection.execute(
      'SELECT id, label, face_count FROM face_groups WHERE label IS NOT NULL AND label != "" ORDER BY label'
    );
    res.json({ groups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get auto-matched faces for review (grouped by target group)
app.get('/api/faces/review', requireAuthWrapper, requirePhotoPermission, async (req, res) => {
  try {
    const { limit = 50, offset = 0, groupId } = req.query;

    let whereClause = `df.match_source = 'auto' AND df.match_reviewed = 0 AND df.suggested_group_id IS NOT NULL`;
    const params = [];

    if (groupId) {
      whereClause += ' AND df.suggested_group_id = ?';
      params.push(parseInt(groupId));
    }

    const [faces] = await db.connection.execute(`
      SELECT df.id, df.file_id, df.face_index, df.confidence, df.gender, df.age, df.expression,
             df.face_descriptor, df.suggested_group_id, df.match_confidence,
             fg.label as group_label,
             sf.name as file_name
      FROM detected_faces df
      JOIN face_groups fg ON df.suggested_group_id = fg.id
      JOIN scanned_files sf ON df.file_id = sf.id
      WHERE ${whereClause}
      ORDER BY df.match_confidence DESC
      LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
    `, params);

    const [total] = await db.connection.execute(
      `SELECT COUNT(*) as c FROM detected_faces df WHERE ${whereClause}`,
      params
    );

    const parsed = faces.map(f => {
      const desc = typeof f.face_descriptor === 'string' ? JSON.parse(f.face_descriptor) : (f.face_descriptor || {});
      return {
        id: f.id,
        fileId: f.file_id,
        faceIndex: f.face_index,
        confidence: f.confidence,
        gender: f.gender,
        age: f.age,
        expression: f.expression,
        thumb: desc?.thumbnail,
        phash: desc?.phash,
        groupId: f.suggested_group_id,
        groupLabel: f.group_label,
        matchConfidence: f.match_confidence,
        model: desc?.model || null,
        fileName: f.file_name
      };
    });

    res.json({ faces: parsed, total: total[0].c });
  } catch (err) {
    console.error('Review faces error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Confirm an auto-match (move suggested_group_id → face_group_id)
app.post('/api/faces/review/:faceId/confirm', requireAuthWrapper, async (req, res) => {
  try {
    const faceId = parseInt(req.params.faceId);
    const [face] = await db.connection.execute('SELECT suggested_group_id FROM detected_faces WHERE id = ?', [faceId]);
    if (face.length > 0 && face[0].suggested_group_id) {
      await db.connection.execute(
        'UPDATE detected_faces SET face_group_id = ?, match_reviewed = 1, match_source = ?, suggested_group_id = NULL WHERE id = ?',
        [face[0].suggested_group_id, 'manual', faceId]
      );
      const [cnt] = await db.connection.execute('SELECT COUNT(*) as c FROM detected_faces WHERE face_group_id = ?', [face[0].suggested_group_id]);
      await db.connection.execute('UPDATE face_groups SET face_count = ? WHERE id = ?', [cnt[0].c, face[0].suggested_group_id]);
    } else {
      await db.connection.execute('UPDATE detected_faces SET match_reviewed = 1 WHERE id = ?', [faceId]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reject an auto-match (clear suggested group)
app.post('/api/faces/review/:faceId/reject', requireAuthWrapper, async (req, res) => {
  try {
    const faceId = parseInt(req.params.faceId);
    await db.connection.execute(
      'UPDATE detected_faces SET suggested_group_id = NULL, match_source = NULL, match_confidence = NULL, match_reviewed = 1 WHERE id = ?',
      [faceId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reassign a face to a different group
app.post('/api/faces/review/:faceId/reassign', requireAuthWrapper, async (req, res) => {
  try {
    const faceId = parseInt(req.params.faceId);
    const { groupId } = req.body;

    const [face] = await db.connection.execute('SELECT face_group_id FROM detected_faces WHERE id = ?', [faceId]);
    if (face.length === 0) return res.status(404).json({ error: 'Face not found' });

    const oldGroupId = face[0].face_group_id;

    await db.connection.execute(
      'UPDATE detected_faces SET face_group_id = ?, match_source = ?, match_reviewed = 1 WHERE id = ?',
      [groupId || null, 'manual', faceId]
    );

    if (oldGroupId) {
      const [cnt] = await db.connection.execute('SELECT COUNT(*) as c FROM detected_faces WHERE face_group_id = ?', [oldGroupId]);
      await db.connection.execute('UPDATE face_groups SET face_count = ? WHERE id = ?', [cnt[0].c, oldGroupId]);
    }
    if (groupId) {
      const [cnt] = await db.connection.execute('SELECT COUNT(*) as c FROM detected_faces WHERE face_group_id = ?', [groupId]);
      await db.connection.execute('UPDATE face_groups SET face_count = ? WHERE id = ?', [cnt[0].c, groupId]);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk confirm all auto-matches for a group
app.post('/api/faces/review/bulk-confirm', requireAuthWrapper, async (req, res) => {
  try {
    const { groupId } = req.body;
    let whereClause = "match_source = 'auto' AND match_reviewed = 0 AND suggested_group_id IS NOT NULL";
    const params = [];
    if (groupId) {
      whereClause += ' AND suggested_group_id = ?';
      params.push(parseInt(groupId));
    }
    // Move suggested → actual
    await db.connection.execute(
      `UPDATE detected_faces SET face_group_id = suggested_group_id, match_reviewed = 1, match_source = 'manual', suggested_group_id = NULL WHERE ${whereClause}`,
      params
    );
    // Update group counts
    if (groupId) {
      const [cnt] = await db.connection.execute('SELECT COUNT(*) as c FROM detected_faces WHERE face_group_id = ?', [groupId]);
      await db.connection.execute('UPDATE face_groups SET face_count = ? WHERE id = ?', [cnt[0].c, groupId]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk reject all auto-matches for a group
app.post('/api/faces/review/bulk-reject', requireAuthWrapper, async (req, res) => {
  try {
    const { groupId } = req.body;
    let whereClause = "match_source = 'auto' AND match_reviewed = 0 AND suggested_group_id IS NOT NULL";
    const params = [];
    if (groupId) {
      whereClause += ' AND suggested_group_id = ?';
      params.push(parseInt(groupId));
    }

    const [affected] = await db.connection.execute(
      `UPDATE detected_faces SET suggested_group_id = NULL, match_source = NULL, match_confidence = NULL, match_reviewed = 1 WHERE ${whereClause}`,
      params
    );

    if (groupId) {
      const [cnt] = await db.connection.execute('SELECT COUNT(*) as c FROM detected_faces WHERE face_group_id = ?', [groupId]);
      await db.connection.execute('UPDATE face_groups SET face_count = ? WHERE id = ?', [cnt[0].c, groupId]);
    }

    res.json({ success: true, removed: affected.affectedRows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Face stats
app.get('/api/faces/stats', requireAuthWrapper, async (req, res) => {
  try {
    const [total] = await db.connection.execute('SELECT COUNT(*) as c FROM detected_faces');
    const [photos] = await db.connection.execute('SELECT COUNT(DISTINCT file_id) as c FROM detected_faces');
    const [male] = await db.connection.execute("SELECT COUNT(*) as c FROM detected_faces WHERE gender='male'");
    const [female] = await db.connection.execute("SELECT COUNT(*) as c FROM detected_faces WHERE gender='female'");
    const [grouped] = await db.connection.execute('SELECT COUNT(*) as c FROM detected_faces WHERE face_group_id IS NOT NULL');
    const [ungrouped] = await db.connection.execute('SELECT COUNT(*) as c FROM detected_faces WHERE face_group_id IS NULL AND face_descriptor IS NOT NULL');
    const [groups] = await db.connection.execute('SELECT COUNT(*) as c FROM face_groups');
    const [named] = await db.connection.execute('SELECT COUNT(*) as c FROM face_groups WHERE label IS NOT NULL AND label != ""');
    res.json({
      totalFaces: total[0].c,
      totalPhotos: photos[0].c,
      male: male[0].c,
      female: female[0].c,
      grouped: grouped[0].c,
      ungrouped: ungrouped[0].c,
      totalGroups: groups[0].c,
      namedGroups: named[0].c
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== FACES V2 API ====================

// Serve faces v2 review page
app.get('/faces-v2', (req, res) => {
  const html = fs.readFileSync(join(__dirname, 'public', 'faces-v2.html'), 'utf8');
  res.send(html);
});

// Get faces v2 list with filters
app.get('/api/faces-v2', requireAuthWrapper, requirePhotoPermission, async (req, res) => {
  try {
    const { status, model, gender, groupId, hasSuggestion, sort, limit, offset } = req.query;
    const result = await db.getFacesV2({ status, model, gender, groupId, hasSuggestion, sort, limit, offset });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get faces v2 stats
app.get('/api/faces-v2/stats', requireAuthWrapper, async (req, res) => {
  try {
    const stats = await db.getFacesV2Stats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get file details for view modal
app.get('/api/faces-v2/file/:fileId', requireAuthWrapper, async (req, res) => {
  try {
    const fileId = parseInt(req.params.fileId);
    const [rows] = await db.connection.execute(`
      SELECT sf.id, sf.name, sf.size, sf.extension, sf.mtime,
             ft.folder_id as folder_path,
             pm.camera_make, pm.camera_model
      FROM scanned_files sf
      LEFT JOIN folder_tree ft ON sf.folder_id_int = ft.id
      LEFT JOIN photo_metadata pm ON sf.id = pm.file_id
      WHERE sf.id = ?
    `, [fileId]);
    if (!rows.length) return res.status(404).json({ error: 'File not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== IGNORED CAMERAS API ====================

// List ignored cameras
app.get('/api/ignored-cameras', requireAuthWrapper, async (req, res) => {
  try {
    const [rows] = await db.connection.execute('SELECT * FROM ignored_cameras ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add ignored camera
app.post('/api/ignored-cameras', requireAuthWrapper, async (req, res) => {
  try {
    const { camera_make, camera_model, reason } = req.body;
    if (!camera_make) return res.status(400).json({ error: 'camera_make required' });
    await db.connection.execute(
      'INSERT IGNORE INTO ignored_cameras (camera_make, camera_model, reason) VALUES (?, ?, ?)',
      [camera_make, camera_model || null, reason || null]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove ignored camera
app.delete('/api/ignored-cameras/:id', requireAuthWrapper, async (req, res) => {
  try {
    await db.connection.execute('DELETE FROM ignored_cameras WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ignore all faces from the same folder as a given file
app.post('/api/faces-v2/ignore-by-folder', requireAuthWrapper, async (req, res) => {
  try {
    const { fileId } = req.body;
    const [file] = await db.connection.execute(
      'SELECT sf.folder_id_int FROM scanned_files sf WHERE sf.id = ?', [fileId]
    );
    if (!file.length || !file[0].folder_id_int) return res.json({ affected: 0 });

    const folderId = file[0].folder_id_int;
    const [result] = await db.connection.execute(
      `UPDATE faces_v2 fv
       JOIN scanned_files sf ON fv.file_id = sf.id
       SET fv.status = 'ignored', fv.reviewed_at = NOW()
       WHERE sf.folder_id_int = ? AND fv.status != 'ignored'`,
      [folderId]
    );
    res.json({ success: true, affected: result.affectedRows, folderId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ignore all faces from the same camera as a given file
app.post('/api/faces-v2/ignore-by-camera', requireAuthWrapper, async (req, res) => {
  try {
    const { fileId } = req.body;
    const [file] = await db.connection.execute(
      `SELECT pm.camera_make FROM photo_metadata pm WHERE pm.file_id = ?`, [fileId]
    );
    if (!file.length || !file[0].camera_make) return res.json({ affected: 0, camera: null });

    const cameraMake = file[0].camera_make;

    // Also add to ignored_cameras table for future scans
    await db.connection.execute(
      'INSERT IGNORE INTO ignored_cameras (camera_make, reason) VALUES (?, ?)',
      [cameraMake, 'Ignored via faces-v2 UI']
    );

    const [result] = await db.connection.execute(
      `UPDATE faces_v2 fv
       JOIN scanned_files sf ON fv.file_id = sf.id
       JOIN photo_metadata pm ON sf.id = pm.file_id
       SET fv.status = 'ignored', fv.reviewed_at = NOW()
       WHERE pm.camera_make = ? AND fv.status != 'ignored'`,
      [cameraMake]
    );
    res.json({ success: true, affected: result.affectedRows, camera: cameraMake });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update single face v2 status
app.put('/api/faces-v2/:faceId', requireAuthWrapper, async (req, res) => {
  try {
    const { faceId } = req.params;
    const updates = req.body;
    updates.reviewedAt = true;
    await db.updateFaceV2Status(faceId, updates);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Confirm face v2 to group
app.post('/api/faces-v2/:faceId/confirm', requireAuthWrapper, async (req, res) => {
  try {
    const { faceId } = req.params;
    const { groupId } = req.body;
    await db.updateFaceV2Status(faceId, {
      faceGroupId: groupId,
      suggestedGroupId: null,  // Clear suggestion - face is now confirmed to a group
      status: 'confirmed',
      matchReviewed: true,
      reviewedAt: true
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reject face v2 suggestion
app.post('/api/faces-v2/:faceId/reject', requireAuthWrapper, async (req, res) => {
  try {
    const { faceId } = req.params;
    await db.updateFaceV2Status(faceId, {
      suggestedGroupId: null,
      status: 'rejected',
      matchReviewed: true,
      reviewedAt: true
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Batch confirm multiple faces
app.post('/api/faces-v2/batch-confirm', requireAuthWrapper, async (req, res) => {
  try {
    const { faceIds, groupId } = req.body;
    if (!Array.isArray(faceIds) || faceIds.length === 0) {
      return res.status(400).json({ error: 'faceIds must be a non-empty array' });
    }
    if (!groupId) {
      return res.status(400).json({ error: 'groupId is required' });
    }
    
    let successCount = 0;
    let failCount = 0;
    const errors = [];
    
    for (const faceId of faceIds) {
      try {
        await db.updateFaceV2Status(faceId, {
          faceGroupId: parseInt(groupId),
          suggestedGroupId: null,  // Clear suggestion - face is now confirmed to a group
          status: 'confirmed',
          matchReviewed: true,
          reviewedAt: true
        });
        successCount++;
      } catch (e) {
        failCount++;
        errors.push({ faceId, error: e.message });
      }
    }
    
    res.json({ success: true, successCount, failCount, errors, total: faceIds.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Batch reject multiple faces
app.post('/api/faces-v2/batch-reject', requireAuthWrapper, async (req, res) => {
  try {
    const { faceIds } = req.body;
    if (!Array.isArray(faceIds) || faceIds.length === 0) {
      return res.status(400).json({ error: 'faceIds must be a non-empty array' });
    }
    
    let successCount = 0;
    let failCount = 0;
    
    for (const faceId of faceIds) {
      try {
        await db.updateFaceV2Status(faceId, {
          suggestedGroupId: null,
          status: 'rejected',
          matchReviewed: true,
          reviewedAt: true
        });
        successCount++;
      } catch (e) {
        failCount++;
      }
    }
    
    res.json({ success: true, successCount, failCount, total: faceIds.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Batch ignore multiple faces
app.post('/api/faces-v2/batch-ignore', requireAuthWrapper, async (req, res) => {
  try {
    const { faceIds } = req.body;
    if (!Array.isArray(faceIds) || faceIds.length === 0) {
      return res.status(400).json({ error: 'faceIds must be a non-empty array' });
    }
    
    let successCount = 0;
    let failCount = 0;
    
    for (const faceId of faceIds) {
      try {
        await db.updateFaceV2Status(faceId, {
          status: 'ignored',
          matchReviewed: true,
          reviewedAt: true
        });
        successCount++;
      } catch (e) {
        failCount++;
      }
    }
    
    res.json({ success: true, successCount, failCount, total: faceIds.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reassign face v2 to different group
app.post('/api/faces-v2/:faceId/reassign', requireAuthWrapper, async (req, res) => {
  try {
    const { faceId } = req.params;
    const { groupId } = req.body;
    await db.updateFaceV2Status(faceId, {
      faceGroupId: groupId,
      suggestedGroupId: null,
      status: 'confirmed',
      matchReviewed: true,
      reviewedAt: true
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk confirm faces v2
app.post('/api/faces-v2/bulk-confirm', requireAuthWrapper, async (req, res) => {
  try {
    const { faceIds, groupId } = req.body;
    if (!faceIds?.length) return res.status(400).json({ error: 'faceIds required' });
    await db.bulkUpdateFacesV2(faceIds, {
      faceGroupId: groupId,
      status: 'confirmed',
      matchReviewed: true,
      reviewedAt: true
    });
    res.json({ success: true, updated: faceIds.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk reject faces v2
app.post('/api/faces-v2/bulk-reject', requireAuthWrapper, async (req, res) => {
  try {
    const { faceIds } = req.body;
    if (!faceIds?.length) return res.status(400).json({ error: 'faceIds required' });
    await db.bulkUpdateFacesV2(faceIds, {
      suggestedGroupId: null,
      status: 'rejected',
      matchReviewed: true,
      reviewedAt: true
    });
    res.json({ success: true, updated: faceIds.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk ignore faces v2
app.post('/api/faces-v2/bulk-ignore', requireAuthWrapper, async (req, res) => {
  try {
    const { faceIds, ignoreType } = req.body;
    if (!faceIds?.length) return res.status(400).json({ error: 'faceIds required' });
    await db.bulkUpdateFacesV2(faceIds, {
      status: 'ignored',
      reviewedAt: true
    });
    res.json({ success: true, updated: faceIds.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Auto-match faces v2 to named groups
app.post('/api/faces-v2/auto-match', requireAuthWrapper, async (req, res) => {
  try {
    const { limit } = req.body;
    const { FaceDetector } = await import('./lib/face-detector.js');
    const detector = new FaceDetector({ model: 'antelopev2' });
    const result = await db.autoMatchFacesV2(detector, limit || 500);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function mode(arr) {
  const freq = {};
  for (const v of arr) { if (v) freq[v] = (freq[v] || 0) + 1; }
  return Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

// ==================== START SERVER ====================

const PORT = process.env.PORT || 14316;

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
      startDriveUsageJob();
      // Preload duplicate groups for instant backup analysis
      preloadDupGroups();
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
