# SilverFileSystem Media Server Guide

A complete web server for browsing and searching your photo, music, and movie libraries with real-time search and filtering.

## Overview

The SilverFileSystem Media Server provides:

- **📊 Master Dashboard** - Overview of all media with storage breakdown and statistics
- **📷 Photo Library** - Search and filter photos by camera, GPS, orientation
- **🎵 Music Player** - Browse music by tracks, artists, albums with search
- **🎬 Movie Player** - Browse movies by quality, duration with search
- **🔌 REST API** - Access your media data programmatically

## Quick Start

### 1. Prepare Your Database

First, scan your media files and extract metadata:

```bash
# Scan your media directories
node bin/cli.js scan /path/to/photos --db --extract-media
node bin/cli.js scan /path/to/music --db --extract-media
node bin/cli.js scan /path/to/movies --db --extract-media
```

### 2. Start the Server

```bash
# Using npm script
npm run server

# Or directly
node server.js

# With custom port
PORT=8080 node server.js
```

### 3. Open in Browser

Navigate to `http://localhost:3000` to see your media dashboard!

## Features

### Master Dashboard

**URL:** `http://localhost:3000/`

- **Overall Statistics**
  - Total media files across all libraries
  - Total storage used
  - Total duration of music and movies
  
- **Library Cards**
  - Quick overview of each library (Photos, Music, Movies)
  - Key statistics per library
  - Click to navigate to specific library

- **Storage Breakdown**
  - Visual bar chart showing storage distribution
  - Percentage breakdown by media type
  - Color-coded segments

### Photo Library

**URL:** `http://localhost:3000/photos`

**Features:**
- Real-time search by filename, camera make/model, location
- Filter by:
  - All photos
  - Photos with GPS data
  - Portrait orientation
  - Landscape orientation
- Grid and list view modes
- Statistics: total photos, storage, cameras, GPS-tagged photos

**Metadata Displayed:**
- Image dimensions
- File size
- Camera make and model
- Date taken
- GPS indicator

### Music Player

**URL:** `http://localhost:3000/music`

**Features:**
- Real-time search by track, artist, album, genre
- Filter by:
  - All tracks
  - FLAC format
  - High quality (≥320kbps)
- Browse by:
  - All tracks
  - Artists (with track and album counts)
  - Albums (with artist and track counts)
- Quality badges (FLAC, 320k, 256k, 192k, etc.)

**Metadata Displayed:**
- Track title and artist
- Album name
- Duration
- Audio quality/bitrate
- Codec information

**Browse by Artist:**
- Click "Artists" in sidebar
- Shows list of all artists with track and album counts
- Click an artist to see their tracks

**Browse by Album:**
- Click "Albums" in sidebar
- Shows list of all albums with artist and track counts
- Click an album to see its tracks

### Movie Player

**URL:** `http://localhost:3000/movies`

**Features:**
- Real-time search by title, genre, codec, description
- Filter by:
  - All movies
  - 4K resolution (≥3840px width)
  - HD resolution (1280-3839px width)
  - Long movies (>2 hours)
- Quality badges (4K, Full HD, HD, SD)

**Metadata Displayed:**
- Movie title
- Resolution
- Duration
- File size
- Description/genre

## REST API

The server exposes a REST API for programmatic access to your media data.

### Endpoints

#### GET /api/health
Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "database": "connected"
}
```

#### GET /api/photos
Get all photos with optional search and filters.

**Query Parameters:**
- `search` - Search term (optional)
- `filter` - Filter type: `gps`, `portrait`, `landscape` (optional)

**Response:**
```json
{
  "photos": [...],
  "stats": {
    "totalPhotos": 150,
    "totalSize": "1.2 GB",
    "uniqueCameras": 3,
    "withGPS": 45
  }
}
```

#### GET /api/music
Get all music tracks with optional search and filters.

**Query Parameters:**
- `search` - Search term (optional)
- `filter` - Filter type: `flac`, `hq` (optional)

**Response:**
```json
{
  "tracks": [...],
  "stats": {
    "totalTracks": 250,
    "totalAlbums": 25,
    "totalArtists": 30,
    "totalDuration": "15h 30m",
    "totalSize": "2.5 GB"
  }
}
```

#### GET /api/music/artists
Get all artists with track and album counts.

**Response:**
```json
{
  "artists": [
    {
      "name": "The Beatles",
      "trackCount": 15,
      "albumCount": 3
    }
  ]
}
```

#### GET /api/music/albums
Get all albums with track information.

**Response:**
```json
{
  "albums": [
    {
      "name": "Abbey Road",
      "artist": "The Beatles",
      "year": 1969,
      "trackCount": 17,
      "duration": 2825.5
    }
  ]
}
```

#### GET /api/music/artist/:name
Get all tracks by a specific artist.

**Example:** `/api/music/artist/The%20Beatles`

**Response:**
```json
{
  "tracks": [...]
}
```

#### GET /api/music/album/:name
Get all tracks in a specific album.

**Example:** `/api/music/album/Abbey%20Road`

**Response:**
```json
{
  "tracks": [...]
}
```

#### GET /api/movies
Get all movies with optional search and filters.

**Query Parameters:**
- `search` - Search term (optional)
- `filter` - Filter type: `4k`, `hd`, `long` (optional)

**Response:**
```json
{
  "movies": [...],
  "stats": {
    "totalMovies": 50,
    "totalDuration": "120h 30m",
    "totalSize": "250 GB",
    "hdCount": 30,
    "fourKCount": 10
  }
}
```

### API Examples

```bash
# Get all photos with GPS data
curl "http://localhost:3000/api/photos?filter=gps"

# Search music by artist
curl "http://localhost:3000/api/music?search=Beatles"

# Get FLAC tracks only
curl "http://localhost:3000/api/music?filter=flac"

# Get all artists
curl "http://localhost:3000/api/music/artists"

# Get tracks by artist
curl "http://localhost:3000/api/music/artist/The%20Beatles"

# Get 4K movies
curl "http://localhost:3000/api/movies?filter=4k"

# Search movies by genre
curl "http://localhost:3000/api/movies?search=sci-fi"
```

## Configuration

### Database Configuration

The server uses the same database configuration as the CLI tools. Configure via:

**Environment Variables:**
```bash
export DB_HOST=localhost
export DB_PORT=3306
export DB_USER=root
export DB_PASSWORD=yourpassword
export DB_NAME=silverfilesystem
```

**Or in `config.json`:**
```json
{
  "database": {
    "host": "localhost",
    "port": 3306,
    "user": "root",
    "password": "yourpassword",
    "database": "silverfilesystem"
  }
}
```

### Port Configuration

Set the port via environment variable:

```bash
PORT=8080 npm run server
```

Default port is `3000`.

## Deployment

### Development

```bash
npm run server
```

### Production with PM2

```bash
# Install PM2
npm install -g pm2

# Start server
pm2 start server.js --name silverfs-server

# Start on boot
pm2 startup
pm2 save

# Monitor
pm2 monit

# View logs
pm2 logs silverfs-server
```

### Production with systemd

Create `/etc/systemd/system/silverfs-server.service`:

```ini
[Unit]
Description=SilverFileSystem Media Server
After=network.target mysql.service

[Service]
Type=simple
User=youruser
WorkingDirectory=/path/to/SilverFileSystem
Environment=NODE_ENV=production
Environment=PORT=3000
ExecStart=/usr/bin/node server.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl daemon-reload
sudo systemctl enable silverfs-server
sudo systemctl start silverfs-server
sudo systemctl status silverfs-server
```

### Docker

Create `Dockerfile`:

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
```

Build and run:

```bash
docker build -t silverfs-server .
docker run -d -p 3000:3000 \
  -e DB_HOST=host.docker.internal \
  -e DB_USER=root \
  -e DB_PASSWORD=password \
  --name silverfs \
  silverfs-server
```

### Reverse Proxy with Nginx

```nginx
server {
    listen 80;
    server_name media.example.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## Security Considerations

### Important Notes

1. **No Authentication** - The server currently has no authentication. Only run on trusted networks.

2. **File Paths** - File paths are exposed in API responses. Ensure your database doesn't contain sensitive path information.

3. **Database Access** - Ensure your MySQL database has proper access controls.

4. **Network Access** - By default, the server listens on `0.0.0.0` (all interfaces). Consider:
   ```bash
   # Listen only on localhost
   HOST=127.0.0.1 node server.js
   ```

### Recommended Security Measures

1. **Use a Reverse Proxy** with authentication (nginx + basic auth or OAuth)
2. **Use HTTPS** with Let's Encrypt certificates
3. **Firewall Rules** to restrict access to trusted IPs
4. **Read-only Database User** for the server
5. **Regular Backups** of your database

## Troubleshooting

### Server won't start

**Check database connection:**
```bash
mysql -h localhost -u root -p
```

**Check port availability:**
```bash
lsof -i :3000
# Or
netstat -tulpn | grep 3000
```

### "No photos/music/movies found"

Make sure you've:
1. Scanned files with `--db` flag
2. Extracted metadata with `--extract-media`
3. Database is accessible

### API returns empty data

Check database tables:
```sql
USE silverfilesystem;
SELECT COUNT(*) FROM scanned_files;
SELECT COUNT(*) FROM photo_metadata;
SELECT COUNT(*) FROM music_metadata;
SELECT COUNT(*) FROM video_metadata;
```

### Search not working

- Search is case-insensitive
- Search includes partial matches
- Try simpler search terms

### Browser shows "Loading..." indefinitely

- Open browser console (F12) to see errors
- Check if API endpoints are accessible: `http://localhost:3000/api/health`
- Verify CORS settings if accessing from different domain

## Performance Tips

### Large Libraries

For collections with 10,000+ items:

1. **Database Indexes** - Already created by default
2. **Pagination** - Consider adding pagination for very large collections
3. **Caching** - Add Redis for API response caching
4. **CDN** - Serve static assets via CDN

### Network Performance

- Enable gzip compression (nginx)
- Use HTTP/2 (nginx)
- Cache static assets in browser

### Database Optimization

```sql
-- Analyze tables
ANALYZE TABLE scanned_files, photo_metadata, music_metadata, video_metadata;

-- Optimize tables
OPTIMIZE TABLE scanned_files, photo_metadata, music_metadata, video_metadata;
```

## Advanced Usage

### Custom Queries

You can extend the API by adding custom routes to `server.js`:

```javascript
// Get photos from specific camera
app.get('/api/photos/camera/:make', async (req, res) => {
  const [photos] = await db.connection.query(`
    SELECT sf.*, pm.*
    FROM scanned_files sf
    JOIN photo_metadata pm ON sf.id = pm.file_id
    WHERE pm.camera_make = ?
  `, [req.params.make]);
  
  res.json({ photos });
});
```

### Webhook Integration

Add webhooks when new media is added:

```javascript
// After storing files in database
fetch('https://your-webhook-url.com/media-added', {
  method: 'POST',
  body: JSON.stringify({ type: 'photo', count: files.length })
});
```

## Related Documentation

- [README.md](README.md) - Main documentation
- [MEDIA.md](MEDIA.md) - Media metadata extraction
- [DATABASE.md](DATABASE.md) - Database schema
- [WEB_UI_GUIDE.md](WEB_UI_GUIDE.md) - Static UI generation

## Support

For issues, questions, or contributions:
- GitHub Issues: https://github.com/NeoSilver997/SilverFileSystem/issues
