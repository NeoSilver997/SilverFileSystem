# Media Metadata Extraction Guide

This guide explains how to extract and store metadata from photos, music, and video files in SilverFileSystem.

## Overview

SilverFileSystem can extract rich metadata from media files including:
- **Photos**: EXIF data, camera settings, GPS coordinates
- **Music**: ID3 tags, album information, audio properties
- **Videos**: Codec information, dimensions, duration, embedded metadata

All extracted metadata is stored in MySQL database tables for advanced querying and analysis.

## Supported Formats

### Photos (Images)
- JPEG (.jpg, .jpeg)
- PNG (.png)
- GIF (.gif)
- BMP (.bmp)
- TIFF (.tiff)
- WebP (.webp)
- HEIC (.heic)
- HEIF (.heif)

### Music (Audio)
- MP3 (.mp3)
- FLAC (.flac)
- WAV (.wav)
- AAC (.aac)
- M4A (.m4a)
- OGG (.ogg)
- WMA (.wma)
- Opus (.opus)

### Movies (Video)
- MP4 (.mp4)
- MKV (.mkv)
- AVI (.avi)
- MOV (.mov)
- WMV (.wmv)
- FLV (.flv)
- WebM (.webm)
- M4V (.m4v)
- MPEG (.mpeg, .mpg)

## Quick Start

### Basic Usage

```bash
# Scan directory and extract media metadata
node bin/cli.js scan /path/to/media --db --extract-media
```

### Real-World Examples

#### Photo Library
```bash
# Scan photo collection with metadata extraction
node bin/cli.js scan /home/user/Photos --db --extract-media \
  --db-user photouser --db-password secret
```

#### Music Collection
```bash
# Scan music library
node bin/cli.js scan /home/user/Music --db --extract-media
```

#### Video Archive
```bash
# Scan video folder
node bin/cli.js scan /mnt/nas/Videos --db --extract-media
```

## Extracted Metadata

### Photo Metadata (photo_metadata table)

| Field | Description | Example |
|-------|-------------|---------|
| width | Image width in pixels | 4032 |
| height | Image height in pixels | 3024 |
| format | Image format | jpeg, png |
| orientation | EXIF orientation | 1-8 |
| camera_make | Camera manufacturer | Canon, Nikon, Apple |
| camera_model | Camera model | EOS 5D Mark IV |
| lens_model | Lens used | EF 24-70mm f/2.8L |
| iso | ISO sensitivity | 100, 400, 1600 |
| aperture | F-stop value | 2.8, 5.6 |
| shutter_speed | Exposure time | 1/125, 1/500 |
| focal_length | Lens focal length | 50mm, 24mm |
| flash | Flash mode | On, Off, Auto |
| date_taken | Photo capture date | 2024-10-30 14:30:00 |
| latitude | GPS latitude | 40.7128 |
| longitude | GPS longitude | -74.0060 |
| altitude | GPS altitude in meters | 10.5 |
| software | Editing software | Photoshop, Lightroom |
| artist | Photographer name | John Doe |
| copyright | Copyright information | © 2024 John Doe |

### Music Metadata (music_metadata table)

| Field | Description | Example |
|-------|-------------|---------|
| title | Track title | Yesterday |
| artist | Artist name | The Beatles |
| album | Album name | Help! |
| album_artist | Album artist | The Beatles |
| year | Release year | 1965 |
| genre | Music genre | Rock, Pop |
| track_number | Track number | 1 |
| track_total | Total tracks | 14 |
| disk_number | Disk number | 1 |
| disk_total | Total disks | 2 |
| duration | Length in seconds | 183.5 |
| bitrate | Bitrate in bps | 320000 |
| sample_rate | Sample rate in Hz | 44100 |
| channels | Audio channels | 2 (stereo) |
| codec | Audio codec | MP3, FLAC |
| composer | Composer name | Lennon-McCartney |
| isrc | International Standard Recording Code | USRC17607839 |
| has_album_art | Album art embedded | true, false |

### Video Metadata (video_metadata table)

| Field | Description | Example |
|-------|-------------|---------|
| title | Video title | Summer Vacation 2024 |
| duration | Length in seconds | 3600 |
| width | Video width in pixels | 1920 |
| height | Video height in pixels | 1080 |
| frame_rate | Frames per second | 29.97, 60 |
| video_codec | Video compression | H.264, H.265 |
| video_bitrate | Video bitrate | 5000000 |
| audio_codec | Audio compression | AAC, MP3 |
| audio_bitrate | Audio bitrate | 192000 |
| audio_sample_rate | Audio sample rate | 48000 |
| audio_channels | Audio channels | 2, 6 |
| description | Video description | Holiday trip |
| genre | Video genre | Documentary |
| artist | Creator | John Doe |
| year | Year created | 2024 |
| create_date | Creation timestamp | 2024-10-30 |
| software | Encoding software | HandBrake |
| latitude | GPS latitude | 40.7128 |
| longitude | GPS longitude | -74.0060 |

## SQL Query Examples

### Photo Queries

#### Find Photos by Camera

```sql
SELECT sf.path, pm.camera_make, pm.camera_model, pm.date_taken
FROM scanned_files sf
JOIN photo_metadata pm ON sf.id = pm.file_id
WHERE pm.camera_make = 'Canon'
ORDER BY pm.date_taken DESC;
```

#### Find High-Resolution Photos

```sql
SELECT sf.path, pm.width, pm.height, 
       (pm.width * pm.height) as megapixels
FROM scanned_files sf
JOIN photo_metadata pm ON sf.id = pm.file_id
WHERE pm.width >= 4000 AND pm.height >= 3000
ORDER BY megapixels DESC;
```

#### Photos with GPS Coordinates

```sql
SELECT sf.path, pm.latitude, pm.longitude, 
       pm.date_taken, pm.camera_model
FROM scanned_files sf
JOIN photo_metadata pm ON sf.id = pm.file_id
WHERE pm.latitude IS NOT NULL 
  AND pm.longitude IS NOT NULL
ORDER BY pm.date_taken;
```

#### Photos by Date Range

```sql
SELECT sf.path, pm.date_taken, pm.camera_make, pm.camera_model
FROM scanned_files sf
JOIN photo_metadata pm ON sf.id = pm.file_id
WHERE pm.date_taken BETWEEN '2024-01-01' AND '2024-12-31'
ORDER BY pm.date_taken;
```

#### Photos by Camera Settings

```sql
-- Find photos taken with specific aperture
SELECT sf.path, pm.aperture, pm.iso, pm.shutter_speed
FROM scanned_files sf
JOIN photo_metadata pm ON sf.id = pm.file_id
WHERE pm.aperture BETWEEN 1.8 AND 2.8
  AND pm.iso <= 400;
```

### Music Queries

#### Find Music by Artist

```sql
SELECT sf.path, mm.title, mm.album, mm.year, mm.duration
FROM scanned_files sf
JOIN music_metadata mm ON sf.id = mm.file_id
WHERE mm.artist LIKE '%Beatles%'
ORDER BY mm.year, mm.album, mm.track_number;
```

#### Find Albums

```sql
SELECT mm.album, mm.album_artist, mm.year, 
       COUNT(*) as track_count,
       SUM(mm.duration) as total_duration
FROM scanned_files sf
JOIN music_metadata mm ON sf.id = mm.file_id
WHERE mm.album IS NOT NULL
GROUP BY mm.album, mm.album_artist, mm.year
ORDER BY mm.year DESC;
```

#### High Quality Audio Files

```sql
SELECT sf.path, mm.title, mm.artist, 
       mm.bitrate, mm.sample_rate, mm.codec
FROM scanned_files sf
JOIN music_metadata mm ON sf.id = mm.file_id
WHERE mm.bitrate >= 320000 
   OR mm.codec = 'FLAC'
ORDER BY mm.bitrate DESC;
```

#### Music by Genre

```sql
SELECT mm.genre, COUNT(*) as track_count,
       SUM(mm.duration) as total_duration_sec,
       ROUND(SUM(mm.duration)/3600, 2) as total_hours
FROM scanned_files sf
JOIN music_metadata mm ON sf.id = mm.file_id
WHERE mm.genre IS NOT NULL
GROUP BY mm.genre
ORDER BY track_count DESC;
```

#### Find Music Without Album Art

```sql
SELECT sf.path, mm.title, mm.artist, mm.album
FROM scanned_files sf
JOIN music_metadata mm ON sf.id = mm.file_id
WHERE mm.has_album_art = false
  AND mm.album IS NOT NULL;
```

### Video Queries

#### Find Long Videos

```sql
SELECT sf.path, vm.title, vm.duration,
       ROUND(vm.duration/60, 2) as duration_minutes
FROM scanned_files sf
JOIN video_metadata vm ON sf.id = vm.file_id
WHERE vm.duration > 3600  -- Longer than 1 hour
ORDER BY vm.duration DESC;
```

#### Find HD/4K Videos

```sql
SELECT sf.path, vm.width, vm.height, 
       vm.video_codec, vm.frame_rate,
       CASE 
         WHEN vm.width >= 3840 THEN '4K'
         WHEN vm.width >= 1920 THEN 'Full HD'
         WHEN vm.width >= 1280 THEN 'HD'
         ELSE 'SD'
       END as quality
FROM scanned_files sf
JOIN video_metadata vm ON sf.id = vm.file_id
ORDER BY vm.width DESC, vm.height DESC;
```

#### Videos by Codec

```sql
SELECT vm.video_codec, 
       COUNT(*) as video_count,
       SUM(sf.size) as total_size,
       ROUND(SUM(sf.size)/1024/1024/1024, 2) as total_gb
FROM scanned_files sf
JOIN video_metadata vm ON sf.id = vm.file_id
GROUP BY vm.video_codec
ORDER BY video_count DESC;
```

#### Total Video Duration

```sql
SELECT COUNT(*) as video_count,
       SUM(vm.duration) as total_seconds,
       ROUND(SUM(vm.duration)/3600, 2) as total_hours,
       ROUND(AVG(vm.duration)/60, 2) as avg_minutes
FROM video_metadata vm;
```

## Programmatic Usage

### Extract Metadata in Node.js

```javascript
import { MediaMetadataExtractor } from './lib/media.js';

const extractor = new MediaMetadataExtractor();

// Extract photo metadata
const photoResult = await extractor.extractMetadata('/path/to/photo.jpg');
if (photoResult && photoResult.type === 'photo') {
  console.log('Camera:', photoResult.metadata.camera);
  console.log('Settings:', photoResult.metadata.settings);
  console.log('Location:', photoResult.metadata.location);
}

// Extract music metadata
const musicResult = await extractor.extractMetadata('/path/to/song.mp3');
if (musicResult && musicResult.type === 'music') {
  console.log('Title:', musicResult.metadata.track.title);
  console.log('Artist:', musicResult.metadata.track.artist);
  console.log('Album:', musicResult.metadata.track.album);
}

// Extract video metadata
const videoResult = await extractor.extractMetadata('/path/to/video.mp4');
if (videoResult && videoResult.type === 'video') {
  console.log('Duration:', videoResult.metadata.video.duration);
  console.log('Resolution:', videoResult.metadata.video.width, 'x', videoResult.metadata.video.height);
}

// Cleanup
await extractor.cleanup();
```

### Store Metadata with Database

```javascript
import { FileScanner } from './lib/scanner.js';
import { DatabaseManager } from './lib/database.js';
import { MediaMetadataExtractor } from './lib/media.js';

const scanner = new FileScanner();
const db = new DatabaseManager();
const extractor = new MediaMetadataExtractor();

await db.connect();
await db.initializeTables();

// Scan directory
const files = await scanner.scanDirectory('/path/to/media');

// Create scan session
const scanId = await db.createScanSession('/path/to/media');

// Store files
await db.storeFilesBatch(files, scanId);

// Extract and store metadata
for (const file of files) {
  const result = await extractor.extractMetadata(file.path);
  if (result) {
    const [rows] = await db.connection.execute(
      'SELECT id FROM scanned_files WHERE path = ?',
      [file.path]
    );
    
    if (rows.length > 0) {
      const fileId = rows[0].id;
      
      if (result.type === 'photo') {
        await db.storePhotoMetadata(fileId, result.metadata);
      } else if (result.type === 'music') {
        await db.storeMusicMetadata(fileId, result.metadata);
      } else if (result.type === 'video') {
        await db.storeVideoMetadata(fileId, result.metadata);
      }
    }
  }
}

// Complete session
await db.completeScanSession(scanId, files.length, totalSize);

// Cleanup
await extractor.cleanup();
await db.close();
```

## Performance Considerations

### Processing Time

- **Photos**: ~50-200ms per file (depends on EXIF complexity)
- **Music**: ~100-500ms per file (depends on file size and format)
- **Videos**: ~200-1000ms per file (depends on file size)

### Large Collections

For large media libraries:

1. **Use Batch Processing** - The system processes files one at a time
2. **Monitor Progress** - Progress is shown during extraction
3. **Consider Time** - A 10,000 file collection may take 30-60 minutes
4. **Database Indexes** - Indexes ensure fast queries after import

### Resource Usage

- **Memory**: Moderate (processes one file at a time)
- **CPU**: High during extraction (metadata parsing)
- **Disk I/O**: High (reading media files)
- **Database**: Moderate (batch inserts used)

## Troubleshooting

### Missing Metadata

Some files may not have complete metadata:
- **Consumer cameras** typically have full EXIF data
- **Phone photos** usually include GPS if location services enabled
- **Edited photos** may lose some EXIF data depending on editor
- **Compressed videos** may have limited metadata

### Unsupported Formats

If a format isn't supported:
- Check the file extension matches supported formats
- Verify the file isn't corrupted
- Some proprietary formats may not be supported

### Slow Extraction

If extraction is slow:
- Use for media-heavy directories only
- Consider running during off-peak hours
- Network drives will be slower than local storage

### Database Storage

Metadata adds approximately:
- **Photos**: ~500 bytes per file
- **Music**: ~1KB per file
- **Videos**: ~800 bytes per file

## Integration Ideas

### Photo Management

```sql
-- Create a photo catalog view
CREATE VIEW photo_catalog AS
SELECT 
  sf.path,
  pm.date_taken,
  pm.camera_make,
  pm.camera_model,
  CONCAT(pm.width, 'x', pm.height) as resolution,
  pm.latitude,
  pm.longitude
FROM scanned_files sf
JOIN photo_metadata pm ON sf.id = pm.file_id;
```

### Music Library

```sql
-- Create a music library view
CREATE VIEW music_library AS
SELECT 
  mm.artist,
  mm.album,
  mm.title,
  mm.year,
  mm.genre,
  CONCAT(FLOOR(mm.duration/60), ':', LPAD(FLOOR(mm.duration%60), 2, '0')) as duration,
  sf.path
FROM scanned_files sf
JOIN music_metadata mm ON sf.id = mm.file_id
ORDER BY mm.artist, mm.year, mm.album, mm.track_number;
```

### Video Archive

```sql
-- Create a video archive view
CREATE VIEW video_archive AS
SELECT 
  vm.title,
  CONCAT(vm.width, 'x', vm.height) as resolution,
  vm.video_codec,
  ROUND(vm.duration/60, 2) as duration_minutes,
  ROUND(sf.size/1024/1024, 2) as size_mb,
  sf.path
FROM scanned_files sf
JOIN video_metadata vm ON sf.id = vm.file_id;
```

## Conclusion

Media metadata extraction provides powerful capabilities for organizing and analyzing your photo, music, and video collections. Combined with SQL queries, you can create detailed reports and find specific files based on any metadata criteria.
