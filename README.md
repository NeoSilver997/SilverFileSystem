# SilverFileSystem

A powerful Node.js file management system inspired by [Czkawka](https://github.com/qarmin/czkawka) for managing and analyzing files across your network.

## Features

- 🔍 **Duplicate File Finder** - Find duplicate files by comparing content hashes
- 📁 **Empty Files & Directories** - Locate empty files and directories
- 📊 **Large Files Finder** - Find and list large files consuming disk space
- 🔗 **Broken Symlinks Detector** - Find broken symbolic links
- ⚠️ **Invalid Names Finder** - Detect files with problematic names
- 🗄️ **MySQL Database Storage** - Store scan results in MySQL for analysis and reporting
- 📷 **Media Metadata Extraction** - Extract EXIF, ID3, and video metadata for photos, music, and movies
- 🌐 **Network Support** - Scan files across network paths and drives
- ⚡ **Fast Scanning** - Optimized file scanning with quick hash support
- 🎨 **Beautiful CLI** - Colorful and user-friendly command-line interface

## Installation

### Install from source

```bash
git clone https://github.com/NeoSilver997/SilverFileSystem.git
cd SilverFileSystem
npm install
```

### Link globally (optional)

```bash
npm link
```

This allows you to use the `silverfs` command from anywhere.

## Usage

### Basic Commands

#### Scan Directory Overview
Get a quick overview of a directory:

```bash
node bin/cli.js scan <directory>
```

Example:
```bash
node bin/cli.js scan /path/to/folder

# With media metadata extraction
node bin/cli.js scan /path/to/folder --extract-media --db
```

#### Find Duplicate Files
Find duplicate files in one or more directories:

```bash
node bin/cli.js duplicates <path1> [path2] [path3...]
```

Options:
- `-m, --min-size <bytes>` - Minimum file size to check (default: 0)
- `-q, --quick` - Use quick hash for faster scanning

Examples:
```bash
# Find all duplicates in a directory
node bin/cli.js duplicates /path/to/folder

# Find duplicates larger than 1MB (1048576 bytes)
node bin/cli.js duplicates /path/to/folder -m 1048576

# Scan multiple directories
node bin/cli.js duplicates /path/folder1 /path/folder2
```

#### Find Duplicates from Database
Query duplicate files from existing database records (no filesystem scanning needed):

```bash
node bin/cli.js find-duplicates-db [options]
```

Options:
- `-m, --min-size <bytes>` - Minimum file size to check (default: 0)
- `--report <path>` - Generate HTML report at specified path
- `--db-host <host>` - Database host
- `--db-user <user>` - Database user
- `--db-password <password>` - Database password
- `--db-name <name>` - Database name

Examples:
```bash
# Find duplicates from database
node bin/cli.js find-duplicates-db

# Find duplicates and generate HTML report
node bin/cli.js find-duplicates-db --report duplicates-report.html

# Find duplicates larger than 1MB
node bin/cli.js find-duplicates-db -m 1048576
```

#### Update File Hashes in Database
Calculate and update file hashes for files already in the database.

**Smart Optimization:** By default, only hashes files that have the same size as other files (potential duplicates). Files with unique sizes are automatically skipped for maximum efficiency.

```bash
node bin/cli.js update-hashes-db [options]
```

Options:
- `-m, --min-size <bytes>` - Minimum file size to process (default: 0)
- `-l, --limit <number>` - Limit number of files to process
- `--stats` - Show optimization statistics before processing
- `--no-smart` - Disable smart optimization (hash all files)
- `--hash-method <method>` - Hash method: smart, quick, full, streaming, sampling
- Database connection options (same as above)

Examples:
```bash
# Update hashes with smart optimization (default - only potential duplicates)
node bin/cli.js update-hashes-db

# Show optimization statistics first
node bin/cli.js update-hashes-db --stats

# Update hashes for files larger than 1MB, limit to 1000 files
node bin/cli.js update-hashes-db -m 1048576 -l 1000

# Hash all files (disable smart optimization)
node bin/cli.js update-hashes-db --no-smart
```

#### Generate Interactive HTML Report
Generate an interactive HTML report for duplicate files from database:

```bash
node bin/cli.js generate-report <output> [options]
```

Options:
- `-m, --min-size <bytes>` - Minimum file size to include (default: 0)
- Database connection options (same as above)

Examples:
```bash
# Generate HTML report
node bin/cli.js generate-report duplicates-report.html

# Generate report for files larger than 10MB
node bin/cli.js generate-report large-duplicates.html -m 10485760
```

The HTML report includes:
- 📊 Interactive statistics dashboard
- 🔍 Search functionality to filter files
- 📁 Collapsible duplicate groups
- 🔄 Sort by size or file count
- 📱 Responsive design for mobile devices
- 🎨 Beautiful gradient design with smooth animations

#### Find Empty Files
Find empty files (0 bytes):

```bash
node bin/cli.js empty-files <path1> [path2...]
```

Example:
```bash
node bin/cli.js empty-files /path/to/folder
```

#### Find Empty Directories
Find empty directories:

```bash
node bin/cli.js empty-dirs <path1> [path2...]
```

Example:
```bash
node bin/cli.js empty-dirs /path/to/folder
```

#### Find Large Files
Find large files consuming disk space:

```bash
node bin/cli.js large-files <path1> [path2...]
```

Options:
- `-m, --min-size <MB>` - Minimum file size in MB (default: 100)
- `-l, --limit <number>` - Maximum number of results (default: 50)

Examples:
```bash
# Find files larger than 100MB
node bin/cli.js large-files /path/to/folder

# Find files larger than 500MB, show top 20
node bin/cli.js large-files /path/to/folder -m 500 -l 20
```

#### Find Broken Symbolic Links
Find broken symbolic links that point to non-existent targets:

```bash
node bin/cli.js broken-symlinks <path1> [path2...]
```

Example:
```bash
node bin/cli.js broken-symlinks /path/to/folder
```

#### Find Invalid File Names
Find files with invalid or problematic names (special characters, trailing spaces, etc.):

```bash
node bin/cli.js invalid-names <path1> [path2...]
```

Example:
```bash
node bin/cli.js invalid-names /path/to/folder
```

## Media Metadata Extraction

SilverFileSystem can extract detailed metadata from photos, music, and video files when used with database storage.

### Supported Media Types

#### Photos (Images)
- **Formats:** JPG, PNG, GIF, BMP, TIFF, WebP, HEIC, HEIF
- **Metadata Extracted:**
  - Dimensions (width, height)
  - Camera information (make, model, lens)
  - Camera settings (ISO, aperture, shutter speed, focal length, flash)
  - Date taken
  - GPS location (latitude, longitude, altitude)
  - Software, artist, copyright

#### Music (Audio)
- **Formats:** MP3, FLAC, WAV, AAC, M4A, OGG, WMA, Opus
- **Metadata Extracted:**
  - Track information (title, artist, album, album artist)
  - Year, genre
  - Track and disk numbers
  - Duration, bitrate, sample rate, channels
  - Codec, composer, ISRC
  - Album art presence

#### Movies (Video)
- **Formats:** MP4, MKV, AVI, MOV, WMV, FLV, WebM, M4V, MPEG
- **Metadata Extracted:**
  - Video properties (duration, dimensions, frame rate, codec, bitrate)
  - Audio properties (codec, sample rate, channels, bitrate)
  - Title, description, genre, artist, year
  - Creation date
  - GPS location (if available)
  - Software/encoder information

### Usage

To extract media metadata, use the `--extract-media` flag with the `--db` flag:

```bash
# Scan with media metadata extraction
node bin/cli.js scan /path/to/media --db --extract-media

# Example: Scan photo library
node bin/cli.js scan /home/user/Photos --db --extract-media

# Example: Scan music collection
node bin/cli.js scan /home/user/Music --db --extract-media

# Example: Scan video folder
node bin/cli.js scan /home/user/Videos --db --extract-media
```

### Extract Metadata from Existing Database Records

If you've already scanned files to the database but didn't extract metadata, you can extract it later without rescanning:

```bash
# Extract metadata for all media files in database
node bin/cli.js extract-media-from-db

# Extract metadata only from a specific scan session
node bin/cli.js extract-media-from-db --scan-id 5

# Process only first 100 files (useful for testing)
node bin/cli.js extract-media-from-db --limit 100

# Skip files that already have metadata
node bin/cli.js extract-media-from-db --skip-existing

# Custom database connection
node bin/cli.js extract-media-from-db --db-host localhost --db-user myuser --db-password mypass
```

This command:
- Reads file paths from the database (no filesystem scanning)
- Checks if files still exist before processing
- Extracts metadata only for photo, music, and video files
- Stores metadata in the appropriate database tables
- Shows progress and summary statistics

### Database Tables for Media

Media metadata is stored in separate tables:

- **photo_metadata** - Camera info, EXIF data, GPS coordinates
- **music_metadata** - Track info, album data, audio format details
- **video_metadata** - Video/audio codecs, dimensions, duration

### Query Examples

```sql
-- Find photos taken with specific camera
SELECT sf.path, pm.camera_make, pm.camera_model, pm.date_taken
FROM scanned_files sf
JOIN photo_metadata pm ON sf.id = pm.file_id
WHERE pm.camera_make LIKE '%Canon%';

-- Find high-resolution photos
SELECT sf.path, pm.width, pm.height
FROM scanned_files sf
JOIN photo_metadata pm ON sf.id = pm.file_id
WHERE pm.width > 4000 AND pm.height > 3000;

-- Find photos with GPS coordinates
SELECT sf.path, pm.latitude, pm.longitude, pm.date_taken
FROM scanned_files sf
JOIN photo_metadata pm ON sf.id = pm.file_id
WHERE pm.latitude IS NOT NULL;

-- Find music by artist
SELECT sf.path, mm.title, mm.album, mm.year
FROM scanned_files sf
JOIN music_metadata mm ON sf.id = mm.file_id
WHERE mm.artist LIKE '%Beatles%';

-- Find long videos
SELECT sf.path, vm.duration, vm.width, vm.height
FROM scanned_files sf
JOIN video_metadata vm ON sf.id = vm.file_id
WHERE vm.duration > 3600  -- Longer than 1 hour
ORDER BY vm.duration DESC;

-- Find high bitrate music files
SELECT sf.path, mm.bitrate, mm.format
FROM scanned_files sf
JOIN music_metadata mm ON sf.id = mm.file_id
WHERE mm.bitrate > 320000  -- > 320 kbps
ORDER BY mm.bitrate DESC;
```

## MySQL Database Storage

SilverFileSystem can store all scanned file information in a MySQL database for persistent storage, analysis, and reporting.

### Database Setup

1. **Create MySQL Database:**
```sql
CREATE DATABASE silverfilesystem;
```

2. **Configure Database Connection:**

You can use environment variables:
```bash
export DB_HOST=localhost
export DB_PORT=3306
export DB_USER=root
export DB_PASSWORD=yourpassword
export DB_NAME=silverfilesystem
```

Or use command-line options (see examples below).

### Using Database Storage

Add the `--db` flag to any scan or duplicate command to store results in MySQL:

```bash
# Scan directory and store to database
node bin/cli.js scan /path/to/folder --db

# With custom database settings
node bin/cli.js scan /path/to/folder --db \
  --db-host localhost \
  --db-port 3306 \
  --db-user myuser \
  --db-password mypass \
  --db-name silverfilesystem

# Find duplicates and store to database
node bin/cli.js duplicates /path/to/folder --db
```

### Database Schema

The system creates three tables:

- **scanned_files** - Stores all scanned file information (path, size, hash, timestamps)
- **scan_sessions** - Tracks scan sessions with statistics
- **duplicate_groups** - Stores duplicate file groups with wasted space calculations

### Querying Database

You can query the database directly to analyze your files:

```sql
-- Find all files larger than 100MB
SELECT path, size FROM scanned_files WHERE size > 104857600 ORDER BY size DESC;

-- Find duplicate files
SELECT hash, COUNT(*) as count, size 
FROM scanned_files 
WHERE hash IS NOT NULL 
GROUP BY hash, size 
HAVING count > 1;

-- Get scan session statistics
SELECT * FROM scan_sessions ORDER BY start_time DESC;
```

## Network Usage

SilverFileSystem can scan files across network paths:

### Windows (UNC Paths)
```bash
node bin/cli.js scan "\\\\server\\share\\folder"
node bin/cli.js duplicates "\\\\server\\share"

# With database storage
node bin/cli.js scan "\\\\server\\share\\folder" --db
```

### Linux/Mac (Mounted Network Drives)
```bash
node bin/cli.js scan /mnt/network/folder
node bin/cli.js duplicates /mnt/network1 /mnt/network2

# With database storage
node bin/cli.js scan /mnt/network/folder --db
```

## API Usage

You can also use SilverFileSystem as a library in your Node.js projects:

```javascript
import { FileScanner } from './lib/scanner.js';
import { DuplicateFinder } from './lib/duplicates.js';
import { EmptyFinder } from './lib/empty.js';
import { LargeFilesFinder } from './lib/large.js';
import { DatabaseManager } from './lib/database.js';

// Scan a directory
const scanner = new FileScanner();
const files = await scanner.scanDirectory('/path/to/folder');

// Find duplicates
const finder = new DuplicateFinder(scanner);
const duplicates = await finder.findDuplicates(['/path/to/folder']);

// Find empty files
const emptyFinder = new EmptyFinder();
const emptyFiles = await emptyFinder.findEmptyFiles('/path/to/folder');

// Find large files
const largeFinder = new LargeFilesFinder(scanner);
const largeFiles = await largeFinder.findLargeFiles(['/path/to/folder'], { 
  minSize: 100 * 1024 * 1024 // 100 MB 
});

// Use database storage
const db = new DatabaseManager({
  host: 'localhost',
  user: 'root',
  password: 'password',
  database: 'silverfilesystem'
});

await db.connect();
await db.initializeTables();

// Create scan session
const scanId = await db.createScanSession('/path/to/folder');

// Store files in batches
await db.storeFilesBatch(files, scanId);

// Complete session
await db.completeScanSession(scanId, files.length, totalSize);

// Query duplicates from database
const duplicates = await db.getDuplicates(1024 * 1024); // Min 1MB

await db.close();
```

## Performance Tips

1. **Use Quick Hash**: For initial duplicate scanning, use the `-q` flag for faster results
2. **Set Minimum Size**: Use `-m` option to skip small files and speed up scanning
3. **Limit Results**: Use `-l` option when finding large files to reduce processing time
4. **Network Paths**: Scanning network drives may be slower due to network latency

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

ISC

## Inspired By

This project is inspired by [Czkawka](https://github.com/qarmin/czkawka), a powerful file management application written in Rust.
