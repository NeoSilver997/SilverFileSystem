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
app.use(compression());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:4000',
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());
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
      await db.rebuildFolderTree();
      res.json({ success: true, message: 'Folder tree rebuilt' });
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
      'SELECT file_count, total_size, recursive_count, recursive_size FROM folder_tree WHERE id = ?',
      [folderId]
    );

    const showHidden = req.query.showHidden === '1';
    const hiddenClause = showHidden ? '' : 'AND hidden = 0';

    const [children] = await db.connection.query(`
      SELECT id, folder_id, folder_name, file_count, total_size, recursive_count, recursive_size, hidden, remark, related_folder_id
      FROM folder_tree
      WHERE parent_id = ? ${hiddenClause}
      ORDER BY total_size DESC
      LIMIT 200
    `, [folderId]);

    // Get direct files (files in this exact folder from scanned_files)
    const [files] = await db.connection.query(`
      SELECT name, size, extension, mtime, ctime
      FROM scanned_files
      WHERE folder_id_int = ?
      ORDER BY size DESC
      LIMIT 50
    `, [folderId]);

    res.json({
      id: folderId,
      path: normalizedPath,
      info: currentInfo.length > 0 ? {
        fileCount: parseInt(currentInfo[0].file_count),
        totalSize: parseInt(currentInfo[0].total_size),
        totalSizeFormatted: formatBytes(parseInt(currentInfo[0].total_size)),
        recursiveCount: parseInt(currentInfo[0].recursive_count),
        recursiveSize: parseInt(currentInfo[0].recursive_size),
        recursiveSizeFormatted: formatBytes(parseInt(currentInfo[0].recursive_size))
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
          relatedFolderId: r.related_folder_id || null
        })),
        ...files.map(r => ({
          name: r.name,
          path: normalizedPath + '\\' + r.name,
          isFolder: false,
          size: parseInt(r.size),
          sizeFormatted: formatBytes(parseInt(r.size)),
          extension: r.extension,
          mtime: r.mtime,
          ctime: r.ctime
        }))
      ]
    });
  } catch (err) {
    console.error('Folder tree error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Check for deleted files in a folder and remove from DB
app.post('/api/folder-tree/check-deleted', requireAuthWrapper, async (req, res) => {
  try {
    const { folderId, remove } = req.body;
    if (!folderId) return res.status(400).json({ error: 'folderId required' });

    const [folderRow] = await db.connection.query('SELECT folder_id FROM folder_tree WHERE id = ?', [folderId]);
    if (folderRow.length === 0) return res.status(404).json({ error: 'Folder not found' });
    const folderPath = folderRow[0].folder_id;

    const [files] = await db.connection.query(
      'SELECT id, name FROM scanned_files WHERE folder_id_int = ?',
      [folderId]
    );

    if (files.length === 0) return res.json({ total: 0, missing: 0, removed: 0, files: [] });

    const BATCH = 100;
    const missing = [];

    for (let i = 0; i < files.length; i += BATCH) {
      const batch = files.slice(i, i + BATCH);
      const checks = batch.map(f => {
        const fullPath = folderPath + '\\' + f.name;
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
    if (remove && missing.length > 0) {
      const DEL_BATCH = 500;
      for (let i = 0; i < missing.length; i += DEL_BATCH) {
        const batch = missing.slice(i, i + DEL_BATCH);
        const ids = batch.map(f => f.id);
        const placeholders = ids.map(() => '?').join(',');
        await db.connection.query(`DELETE FROM scanned_files WHERE id IN (${placeholders})`, ids);
        removed += batch.length;
      }
    }

    res.json({
      total: files.length,
      missing: missing.length,
      removed,
      files: missing.map(f => ({ id: f.id, name: f.name, path: f.path }))
    });
  } catch (err) {
    console.error('Check deleted error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Delete file record from database by path
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

    const [result] = await db.connection.query(
      'DELETE FROM scanned_files WHERE name = ? AND folder_id_int = ?',
      [fileName, folderRow[0].id]
    );

    res.json({ deleted: result.affectedRows });
  } catch (err) {
    console.error('Delete file error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

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

    const BATCH = 100;
    const missing = [];

    for (let i = 0; i < files.length; i += BATCH) {
      const batch = files.slice(i, i + BATCH);
      const checks = batch.map(f => {
        const fullPath = f.folder_path + '\\' + f.name;
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
    }

    res.json({
      total: files.length,
      missing: missing.length,
      removed,
      archived,
      foldersChecked: folderIds.length,
      files: missing.slice(0, 100).map(f => ({ id: f.id, name: f.name, path: f.path }))
    });
  } catch (err) {
    console.error('Check deleted error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Delete file record from database by path
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
    const [result] = await db.connection.query(
      'DELETE FROM scanned_files WHERE name = ? AND folder_id_int = ?',
      [fileName, folderRow[0].id]
    );
    res.json({ deleted: result.affectedRows });
  } catch (err) {
    console.error('Delete file error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Serve tree view page
app.get('/tree', (req, res) => {
  const html = fs.readFileSync(join(__dirname, 'public', 'tree.html'), 'utf8');
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

app.get('/api/backup-analysis', requireAuthWrapper, async (req, res) => {
  try {
    const folderRaw = req.query.folder;
    if (!folderRaw) return res.status(400).json({ error: 'folder parameter required' });
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const folder = folderRaw.replace(/\\/g, '/').replace(/\/+$/, '');

    // Check cache (5 min TTL)
    const now = Date.now();
    if (backupAnalysisCache && backupAnalysisCacheFolder === folder && (now - backupAnalysisCacheTime) < 300000) {
      return res.json(backupAnalysisCache);
    }

    // Get matching folder IDs first (index-friendly)
    const [targetFolderRows] = await db.connection.query(`
      SELECT id FROM folder_tree WHERE REPLACE(folder_id, '\\\\', '/') LIKE ?
    `, [folder + '%']);
    const targetFolderIds = targetFolderRows.map(f => f.id);

    let files = [];
    if (targetFolderIds.length > 0) {
      const BATCH = 500;
      for (let i = 0; i < targetFolderIds.length; i += BATCH) {
        const batch = targetFolderIds.slice(i, i + BATCH);
        const placeholders = batch.map(() => '?').join(',');
        const [batchFiles] = await db.connection.query(`
          SELECT sf.id, sf.name, sf.size, sf.hash, sf.extension, ft.folder_id as folder_path
          FROM scanned_files sf
          LEFT JOIN folder_tree ft ON sf.folder_id_int = ft.id
          WHERE sf.folder_id_int IN (${placeholders})
          ORDER BY sf.name
        `, batch);
        files.push(...batchFiles);
      }
    }

    // Separate hashed vs unhashed
    const hashed = files.filter(f => f.hash);
    const unhashed = files.filter(f => !f.hash);

    // Check hashed files for copies elsewhere
    const hashes = [...new Set(hashed.map(f => f.hash))];
    const dupMap = new Map();

    if (hashes.length > 0) {
      // Build folder_ids to exclude (all folder_ids matching our target path)
      const [excludeFolders] = await db.connection.query(`
        SELECT id FROM folder_tree WHERE REPLACE(folder_id, '\\\\', '/') LIKE ?
      `, [folder + '%']);
      const excludeIds = excludeFolders.map(f => f.id);

      const BATCH = 500;
      for (let i = 0; i < hashes.length; i += BATCH) {
        const batch = hashes.slice(i, i + BATCH);
        const placeholders = batch.map(() => '?').join(',');
        let dupQuery, dupParams;
        if (excludeIds.length > 0) {
          const exPh = excludeIds.map(() => '?').join(',');
          dupQuery = `
            SELECT sf.hash, sf.name, sf.size, ft.folder_id as folder_path, ft.folder_name
            FROM scanned_files sf
            LEFT JOIN folder_tree ft ON sf.folder_id_int = ft.id
            WHERE sf.hash IN (${placeholders})
              AND sf.folder_id_int NOT IN (${exPh})
          `;
          dupParams = [...batch, ...excludeIds];
        } else {
          dupQuery = `
            SELECT sf.hash, sf.name, sf.size, ft.folder_id as folder_path, ft.folder_name
            FROM scanned_files sf
            LEFT JOIN folder_tree ft ON sf.folder_id_int = ft.id
            WHERE sf.hash IN (${placeholders})
          `;
          dupParams = batch;
        }
        const [dups] = await db.connection.query(dupQuery, dupParams);
        for (const d of dups) {
          if (!dupMap.has(d.hash)) dupMap.set(d.hash, []);
          dupMap.get(d.hash).push({
            path: d.folder_path ? d.folder_path + '\\' + d.name : d.name,
            name: d.name,
            folder: d.folder_name || d.folder_id
          });
        }
      }
    }

    // Build results
    const withCopy = [];
    const withoutCopy = [];

    for (const file of hashed) {
      const others = dupMap.get(file.hash);
      if (others && others.length > 0) {
        withCopy.push({
          id: file.id,
          name: file.name,
          path: file.folder_path ? file.folder_path + '\\' + file.name : file.name,
          size: file.size,
          sizeFormatted: formatBytes(parseInt(file.size)),
          extension: file.extension,
          copies: others.length,
          copyLocations: others.slice(0, 5)
        });
      } else {
        withoutCopy.push({
          id: file.id,
          name: file.name,
          path: file.folder_path ? file.folder_path + '\\' + file.name : file.name,
          size: file.size,
          sizeFormatted: formatBytes(parseInt(file.size)),
          extension: file.extension
        });
      }
    }

    // Sort by size
    withCopy.sort((a, b) => b.size - a.size);
    withoutCopy.sort((a, b) => b.size - a.size);

    const wastedByCopies = withCopy.reduce((sum, f) => sum + f.size * (f.copies), 0);

    const response = {
      summary: {
        totalFiles: files.length,
        hashed: hashed.length,
        unhashed: unhashed.length,
        withCopy: withCopy.length,
        withoutCopy: withoutCopy.length,
        wastedSpace: wastedByCopies,
        wastedFormatted: formatBytes(wastedByCopies)
      },
      withCopy: withCopy.slice(0, limit),
      withoutCopy: withoutCopy.slice(0, limit),
      unhashed: unhashed.sort((a, b) => b.size - a.size).map(f => ({
        id: f.id,
        name: f.name,
        path: f.folder_path ? f.folder_path + '\\' + f.name : f.name,
        size: f.size,
        sizeFormatted: formatBytes(parseInt(f.size)),
        extension: f.extension
      }))
    };

    backupAnalysisCache = response;
    backupAnalysisCacheTime = now;
    backupAnalysisCacheFolder = folder;
    res.json(response);
  } catch (err) {
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
    const missingIds = [];

    const BATCH = 100;
    for (let i = 0; i < files.length; i += BATCH) {
      const batch = files.slice(i, i + BATCH);
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

    res.json({ deleted, kept, total: files.length });
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
    const { search, filter, camera, model, year, month, days } = req.query;
    
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
    
    // Filter out photos with future dates
    const today = new Date();
    photos = photos.filter(photo => {
      if (!photo.date_taken) return true;
      const photoDate = new Date(photo.date_taken);
      return photoDate <= today;
    });
    
    // Default: last 7 days if no other filter specified (including days)
    const hasAnyFilter = search || filter || camera || model || year || month || (days !== undefined && days !== '');
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
    const { stdout: output } = await execFileAsync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,DriveType,Size,FreeSpace | ConvertTo-Json`
    ], { timeout: 10000 });
    const cleaned = output.replace(/^\uFEFF/, '').trim();
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
      startDriveUsageJob();
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
