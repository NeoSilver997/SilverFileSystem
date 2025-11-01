#!/usr/bin/env node

import express from 'express';
import cors from 'cors';
import { DatabaseManager } from './lib/database.js';
import { loadConfig } from './lib/utils.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const config = loadConfig();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

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

// Get all photos with optional search and filters
app.get('/api/photos', async (req, res) => {
  try {
    const { search, filter } = req.query;
    
    let photos = await db.getPhotosWithMetadata();
    
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

const PORT = process.env.PORT || 3000;

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
      console.log(`\n🔌 API Documentation: http://localhost:${PORT}\n`);
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
