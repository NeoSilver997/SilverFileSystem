#!/usr/bin/env node

import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { DatabaseManager } from './lib/database.js';
import { loadConfig } from './lib/utils.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const config = loadConfig();

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

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/api/', apiLimiter);

// Database connection
let db = null;

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

  // Serve image files (after database is initialized)
  app.get('/images/:id', async (req, res) => {
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
}

// Helper function to format bytes
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ==================== API ROUTES ====================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', database: db ? 'connected' : 'disconnected' });
});

// Cached summary data
let summaryCache = null;
let summaryCacheTime = 0;
const SUMMARY_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Get cached summary statistics for dashboard header
app.get('/api/summary', async (req, res) => {
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

// Get all photos with optional search and filters
app.get('/api/photos', async (req, res) => {
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
app.get('/api/music', async (req, res) => {
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
    if (filter === 'flac') {
      tracks = tracks.filter(track => track.codec === 'FLAC');
    } else if (filter === 'hq') {
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
app.get('/api/movies', async (req, res) => {
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
app.get('/api/music/artists', async (req, res) => {
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
app.get('/api/music/albums', async (req, res) => {
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
app.get('/api/music/artist/:name', async (req, res) => {
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
app.get('/api/music/album/:name', async (req, res) => {
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
