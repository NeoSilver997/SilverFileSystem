# Web UI Guide - Photo Library, Music Player, and Movie Player

This guide explains how to generate and use the specialized web UIs for browsing your media collections.

## Overview

SilverFileSystem now includes three beautiful, interactive web interfaces for managing your media:

- **📷 Photo Library** - Browse photos with EXIF metadata, GPS data, and camera information
- **🎵 Music Player** - Manage your music collection with playlists and track information
- **🎬 Movie Player** - Browse movies with quality badges and detailed codec information

## Prerequisites

Before generating web UIs, you need to:

1. **Scan your media files** to the database
2. **Extract metadata** from your media files

```bash
# Scan directory and extract metadata
node bin/cli.js scan /path/to/media --db --extract-media

# Or extract metadata from already scanned files
node bin/cli.js extract-media-from-db
```

## Generating Web UIs

### Photo Library

Generate an interactive photo gallery with EXIF data, GPS locations, and camera information:

```bash
node bin/cli.js generate-photo-library photo-library.html
```

**Features:**
- 📸 Grid and list view modes
- 🔍 Search by filename, camera make/model, location
- 🎯 Filter by GPS data, orientation (portrait/landscape)
- 🖼️ Lightbox modal with full EXIF metadata display
- 📍 GPS coordinates and altitude display
- ⌨️ Keyboard navigation (arrow keys, ESC)
- 📱 Fully responsive design

**Metadata Displayed:**
- Image dimensions and file size
- Camera make and model
- Lens information
- Camera settings (ISO, aperture, shutter speed, focal length)
- Date and time taken
- GPS coordinates and altitude
- Software and copyright information

### Music Player

Generate an interactive music player with playlists and track management:

```bash
node bin/cli.js generate-music-player music-player.html
```

**Features:**
- 🎵 Track list with album and duration
- 📝 Playlists sidebar (All Tracks, Artists, Albums)
- 🔍 Search tracks, artists, and albums
- 🎚️ Quality badges (FLAC, 320k, 256k, etc.)
- 🎯 Filter by format (FLAC, High Quality)
- ⏯️ Simulated playback controls
- 🔀 Shuffle and repeat buttons
- 📊 Progress bar and time display
- 📱 Responsive design for mobile

**Metadata Displayed:**
- Track title, artist, album
- Year, genre, composer
- Track and disk numbers
- Duration and bitrate
- Sample rate and channels
- Audio codec information
- Album art indicator

### Movie Player

Generate an interactive movie browser and player:

```bash
node bin/cli.js generate-movie-player movie-player.html
```

**Features:**
- 🎬 Grid and list view modes
- 🏷️ Quality badges (4K, Full HD, HD, SD)
- 🔍 Search by title, genre, codec
- 🎯 Filter by resolution (4K, HD) and duration
- 🎥 Video player placeholder
- 📊 Detailed metadata modal
- ⌨️ Keyboard navigation (ESC to close)
- 📱 Responsive design

**Metadata Displayed:**
- Video resolution and codec
- Audio codec and channels
- Duration and file size
- Frame rate and bitrate
- Genre, year, description
- Creation date and encoder software
- GPS location (if available)

## Command Options

All three commands support the following database options:

```bash
--db-host <host>        Database host (default: localhost)
--db-port <port>        Database port (default: 3306)
--db-user <user>        Database user (default: root)
--db-password <pass>    Database password
--db-name <name>        Database name (default: silverfilesystem)
```

### Examples

```bash
# Generate photo library with custom database
node bin/cli.js generate-photo-library my-photos.html \
  --db-host 192.168.1.100 \
  --db-user photouser \
  --db-password secret

# Generate music player
node bin/cli.js generate-music-player my-music.html

# Generate movie player with remote database
node bin/cli.js generate-movie-player my-movies.html \
  --db-host media-server.local \
  --db-name media_db
```

## Usage Workflow

### Complete Example: Photo Library

1. **Scan your photo directory:**
   ```bash
   node bin/cli.js scan /home/user/Photos --db --extract-media
   ```

2. **Generate the photo library UI:**
   ```bash
   node bin/cli.js generate-photo-library photos.html
   ```

3. **Open in browser:**
   ```bash
   # Linux/Mac
   open photos.html
   
   # Windows
   start photos.html
   ```

### Complete Example: Music Collection

1. **Scan your music directory:**
   ```bash
   node bin/cli.js scan /home/user/Music --db --extract-media
   ```

2. **Generate the music player UI:**
   ```bash
   node bin/cli.js generate-music-player music.html
   ```

3. **Open in browser and enjoy your collection!**

### Complete Example: Movie Collection

1. **Scan your movie directory:**
   ```bash
   node bin/cli.js scan /home/user/Movies --db --extract-media
   ```

2. **Generate the movie player UI:**
   ```bash
   node bin/cli.js generate-movie-player movies.html
   ```

3. **Browse your cinema collection in the browser!**

## Features and Interactions

### Photo Library Interactions

- **Click on a photo** to open the lightbox modal with full metadata
- **Use arrow keys** to navigate between photos in the modal
- **Press ESC** to close the modal
- **Type in search box** to filter photos in real-time
- **Click filter buttons** to filter by GPS, orientation
- **Toggle Grid/List views** for different browsing experiences

### Music Player Interactions

- **Click on a track** to "play" it (shows in Now Playing section)
- **Use search** to find tracks, artists, or albums
- **Filter by quality** (FLAC, High Quality, Recently Added)
- **View playlists** in the sidebar
- **Control playback** with play/pause, previous/next buttons
- **Progress bar** simulates playback progress

### Movie Player Interactions

- **Click on a movie** to view details and video player placeholder
- **Hover over cards** to see play overlay
- **Use search** to find movies by title, genre, or codec
- **Filter by quality** (4K, HD) or duration (Long >2h)
- **Toggle Grid/List views** for different browsing experiences
- **Press ESC** to close the movie details modal

## Tips and Best Practices

### Performance

- **Large Collections**: The UIs handle hundreds of items efficiently. For very large collections (10,000+ items), consider filtering or pagination.
- **File Paths**: File paths are stored in the HTML. These UIs are meant for personal use on your local network.
- **Images**: Photos don't embed image data - they reference file paths. Ensure paths are accessible from where you open the HTML.

### Customization

All UIs are self-contained HTML files with embedded CSS and JavaScript. You can:

- Edit the HTML directly to customize colors, fonts, or layouts
- Modify the embedded styles in the `<style>` section
- Adjust the JavaScript for different behaviors

### Regeneration

You can regenerate the UIs at any time to reflect updated metadata:

```bash
# After adding more photos
node bin/cli.js scan /new/photos --db --extract-media
node bin/cli.js generate-photo-library photos.html

# After extracting metadata for existing files
node bin/cli.js extract-media-from-db
node bin/cli.js generate-music-player music.html
```

### Sharing

The generated HTML files are completely standalone and can be:

- Opened directly in any modern web browser
- Hosted on a web server
- Shared with others (note: file paths won't work for others unless shared)
- Archived for offline browsing

## Troubleshooting

### "No photos/music/movies found in database"

**Solution:** Make sure you've:
1. Scanned files with `--db` flag
2. Extracted metadata with `--extract-media` or `extract-media-from-db`

```bash
# Scan and extract in one command
node bin/cli.js scan /path/to/media --db --extract-media
```

### "Cannot connect to database"

**Solution:** Verify database credentials and ensure MySQL is running:

```bash
# Test database connection
mysql -h localhost -u root -p

# Check if database exists
SHOW DATABASES LIKE 'silverfilesystem';
```

### Images don't show in Photo Library

**Explanation:** The photo library uses `file://` protocol to reference images. This requires the HTML file and photos to be accessible from the same machine.

**Note:** Actual image display is browser-dependent and requires file system access. The metadata and layout work regardless.

### Music doesn't play

**Note:** The music player currently simulates playback with progress bars and controls. To add actual audio playback, you would need to:
1. Serve the HTML via HTTP server
2. Ensure music files are web-accessible
3. Modify the JavaScript to use HTML5 `<audio>` elements

### Videos don't play

**Note:** The movie player shows a placeholder for the video player. To add actual video playback, you would need to:
1. Serve the HTML via HTTP server
2. Ensure video files are web-accessible
3. Modify the JavaScript to use HTML5 `<video>` elements

## Technical Details

### Browser Compatibility

All UIs work in modern browsers:
- ✅ Chrome/Edge (recommended)
- ✅ Firefox
- ✅ Safari
- ✅ Opera

### Technologies Used

- Pure HTML5, CSS3, and JavaScript (no external dependencies)
- CSS Grid and Flexbox for layouts
- ES6+ JavaScript features
- Responsive design with media queries
- CSS transitions and animations

### Data Format

The UIs embed JSON data directly in the HTML as JavaScript variables. Example:

```javascript
const photosData = [
  {
    id: 1,
    path: '/photos/vacation/beach.jpg',
    name: 'beach.jpg',
    camera_make: 'Canon',
    // ... more metadata
  }
];
```

## Future Enhancements

Potential improvements (not currently implemented):

- Actual audio/video playback
- Thumbnail generation
- Map view for GPS-tagged photos
- Batch operations (delete, move, etc.)
- Integration with cloud storage
- Progressive Web App (PWA) features
- Dark/light theme toggle

## Related Commands

- `scan` - Scan directory and store to database
- `extract-media-from-db` - Extract metadata from existing database records
- `find-duplicates-db` - Find duplicate files in database
- `generate-report` - Generate duplicate files report

## See Also

- [README.md](README.md) - Main documentation
- [MEDIA.md](MEDIA.md) - Media metadata extraction guide
- [DATABASE.md](DATABASE.md) - Database schema and queries
