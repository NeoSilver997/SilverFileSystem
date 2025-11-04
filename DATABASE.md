# SilverFileSystem - Database Integration Guide

This guide explains how to use the MySQL database integration feature in SilverFileSystem.

## Overview

The database feature allows you to store all scanned file information in a MySQL database for:
- Persistent storage of scan results
- Historical tracking of file changes
- Advanced querying and reporting
- Integration with other data analysis tools
- **Version-tracked schema migrations** for safe database updates

> **Note:** SilverFileSystem now includes a robust version tracking system for database migrations. See [DATABASE_MIGRATIONS.md](./DATABASE_MIGRATIONS.md) for details on the migration system and how to add new migrations.

## Prerequisites

- MySQL 5.7+ or MariaDB 10.2+
- Node.js 16+ with mysql2 package (automatically installed)

## Configuration

SilverFileSystem supports multiple ways to configure database connection:

### 1. Environment Variables (.env file) - Recommended

Create a `.env` file in the project root:

```bash
# MySQL Database Configuration
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=sfs
DB_PASSWORD=SilverFS_Secure2025!
DB_NAME=silverfilesystem
```

### 2. Configuration File (config.json)

Alternatively, use `config.json`:

```json
{
  "database": {
    "host": "127.0.0.1",
    "port": 3306,
    "user": "sfs",
    "password": "SilverFS_Secure2025!",
    "database": "silverfilesystem"
  }
}
```

### 3. Command Line Options

Override any setting with CLI options:

```bash
silverfs scan /path/to/scan --db --db-host localhost --db-user myuser
```

**Configuration Precedence**: Environment Variables > CLI Options > config.json > Built-in defaults

## Quick Start

### 1. Create Database

```sql
CREATE DATABASE silverfilesystem CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

### 2. Configure Connection

Option A: Using environment variables (recommended)
```bash
export DB_HOST=localhost
export DB_PORT=3306
export DB_USER=root
export DB_PASSWORD=yourpassword
export DB_NAME=silverfilesystem
```

Option B: Using command-line options
```bash
node bin/cli.js scan /path --db --db-host localhost --db-user myuser --db-password mypass
```

### 3. Run Scan with Database Storage

```bash
# Scan and store to database
node bin/cli.js scan /path/to/folder --db

# Find duplicates and store to database
node bin/cli.js duplicates /path/to/folder --db
```

## Database Schema

The system automatically creates the following tables:

### db_version

**NEW**: Tracks database schema version for safe migrations.

| Column | Type | Description |
|--------|------|-------------|
| id | INT | Primary key |
| version | INT | Schema version number (unique) |
| description | VARCHAR(255) | Description of the migration |
| applied_at | TIMESTAMP | When the migration was applied |

Indexes:
- version (unique)

This table enables version-tracked migrations, ensuring schema updates can be applied safely and incrementally. See [DATABASE_MIGRATIONS.md](./DATABASE_MIGRATIONS.md) for details.

### scanned_files

Stores detailed information about each scanned file.

| Column | Type | Description |
|--------|------|-------------|
| id | INT | Primary key |
| path | VARCHAR(2048) | Full file path |
| name | VARCHAR(512) | File name |
| size | BIGINT | File size in bytes |
| hash | VARCHAR(64) | SHA-256 hash (for duplicates) |
| quick_hash | VARCHAR(64) | Quick hash (first/last chunks) |
| extension | VARCHAR(50) | File extension |
| mtime | DATETIME | Last modification time |
| atime | DATETIME | Last access time |
| ctime | DATETIME | Creation time |
| scan_id | INT | Reference to scan_sessions |
| created_at | TIMESTAMP | Record creation time |
| updated_at | TIMESTAMP | Record update time |

Indexes:
- path (prefix 255)
- size
- hash
- quick_hash
- extension
- scan_id

### scan_sessions

Tracks scan operations and their statistics.

| Column | Type | Description |
|--------|------|-------------|
| id | INT | Primary key |
| scan_path | VARCHAR(2048) | Path that was scanned |
| total_files | INT | Number of files scanned |
| total_size | BIGINT | Total size of files |
| start_time | DATETIME | Scan start time |
| end_time | DATETIME | Scan end time |
| status | VARCHAR(50) | running, completed, failed |
| created_at | TIMESTAMP | Record creation time |

### duplicate_groups

Stores information about duplicate file groups.

| Column | Type | Description |
|--------|------|-------------|
| id | INT | Primary key |
| hash | VARCHAR(64) | File hash |
| file_count | INT | Number of duplicate files |
| file_size | BIGINT | Size of each file |
| wasted_space | BIGINT | Total wasted space |
| created_at | TIMESTAMP | Record creation time |

## Usage Examples

### Scanning and Storing

```bash
# Basic scan with database storage
node bin/cli.js scan /home/user/documents --db

# Scan network drive with database
node bin/cli.js scan /mnt/network/shared --db

# Scan with custom database settings
node bin/cli.js scan /data --db \
  --db-host mysql.example.com \
  --db-port 3306 \
  --db-user scanner \
  --db-password secret123 \
  --db-name file_tracking
```

### Finding Duplicates with Database

```bash
# Find duplicates and store to database
node bin/cli.js duplicates /path/to/folder --db

# Find large duplicates (>10MB) and store
node bin/cli.js duplicates /path/to/folder -m 10485760 --db
```

## SQL Query Examples

### Find All Large Files

```sql
SELECT path, size, ROUND(size/1024/1024, 2) as size_mb
FROM scanned_files
WHERE size > 104857600  -- 100 MB
ORDER BY size DESC
LIMIT 50;
```

### Find Duplicate Files

```sql
SELECT hash, COUNT(*) as count, size, 
       ROUND(size * (COUNT(*) - 1) / 1024 / 1024, 2) as wasted_mb
FROM scanned_files
WHERE hash IS NOT NULL
GROUP BY hash, size
HAVING count > 1
ORDER BY wasted_mb DESC;
```

### List Duplicate File Paths

```sql
SELECT sf.path, sf.size, sf.hash
FROM scanned_files sf
INNER JOIN (
  SELECT hash, size
  FROM scanned_files
  WHERE hash IS NOT NULL
  GROUP BY hash, size
  HAVING COUNT(*) > 1
) duplicates ON sf.hash = duplicates.hash AND sf.size = duplicates.size
ORDER BY sf.hash, sf.path;
```

### Find Empty Files

```sql
SELECT path, name
FROM scanned_files
WHERE size = 0
ORDER BY path;
```

### File Count by Extension

```sql
SELECT extension, 
       COUNT(*) as file_count,
       ROUND(SUM(size)/1024/1024, 2) as total_mb
FROM scanned_files
GROUP BY extension
ORDER BY total_mb DESC;
```

### Scan Session History

```sql
SELECT id, scan_path, total_files, 
       ROUND(total_size/1024/1024/1024, 2) as total_gb,
       start_time, end_time,
       TIMESTAMPDIFF(SECOND, start_time, end_time) as duration_seconds
FROM scan_sessions
ORDER BY start_time DESC;
```

### Files Modified Recently

```sql
SELECT path, size, mtime
FROM scanned_files
WHERE mtime > DATE_SUB(NOW(), INTERVAL 7 DAY)
ORDER BY mtime DESC;
```

### Total Wasted Space by Duplicates

```sql
SELECT SUM(wasted_space) as total_wasted_bytes,
       ROUND(SUM(wasted_space)/1024/1024/1024, 2) as total_wasted_gb
FROM duplicate_groups;
```

## Programmatic Usage

### Using DatabaseManager in Node.js

```javascript
import { DatabaseManager } from './lib/database.js';

// Initialize database
const db = new DatabaseManager({
  host: 'localhost',
  user: 'root',
  password: 'password',
  database: 'silverfilesystem'
});

// Connect
await db.connect();
await db.initializeTables();

// Create scan session
const scanId = await db.createScanSession('/path/to/scan');

// Store files
const files = [/* scanned files */];
await db.storeFilesBatch(files, scanId);

// Complete session
await db.completeScanSession(scanId, files.length, totalSize);

// Query files
const largeFiles = await db.queryFiles({
  minSize: 100 * 1024 * 1024, // 100 MB
  limit: 50
});

// Get duplicates
const duplicates = await db.getDuplicates(1024 * 1024); // Min 1MB

// Get statistics
const stats = await db.getStatistics(scanId);

// Close connection
await db.close();
```

## Performance Optimization

### Batch Inserts

The system automatically uses batch inserts for better performance when storing many files:

```javascript
// Automatically batched in CLI commands
node bin/cli.js scan /large/directory --db
```

### Indexes

The database schema includes indexes on:
- File paths (for quick lookups)
- File sizes (for filtering)
- Hashes (for duplicate detection)
- Extensions (for grouping)
- Scan IDs (for session queries)

### Query Optimization Tips

1. **Use indexes** - Always filter on indexed columns (size, hash, extension)
2. **Limit results** - Use `LIMIT` for large result sets
3. **Date ranges** - Use date indexes when querying by modification time
4. **Aggregation** - Use `GROUP BY` efficiently for summary reports

## Backup and Maintenance

### Backup Database

```bash
mysqldump -u root -p silverfilesystem > backup.sql
```

### Restore Database

```bash
mysql -u root -p silverfilesystem < backup.sql
```

### Clean Old Scans

```sql
-- Delete scans older than 90 days
DELETE FROM scanned_files 
WHERE scan_id IN (
  SELECT id FROM scan_sessions 
  WHERE start_time < DATE_SUB(NOW(), INTERVAL 90 DAY)
);

DELETE FROM scan_sessions 
WHERE start_time < DATE_SUB(NOW(), INTERVAL 90 DAY);
```

## Troubleshooting

### Connection Issues

**Error:** "Failed to connect to database"

Solution:
- Check MySQL is running: `systemctl status mysql`
- Verify credentials are correct
- Check firewall allows port 3306
- Test connection: `mysql -h localhost -u root -p`

### Permission Issues

**Error:** "Access denied for user"

Solution:
```sql
GRANT ALL PRIVILEGES ON silverfilesystem.* TO 'sfs'@'localhost';
FLUSH PRIVILEGES;
```

### Character Encoding Issues

If you see garbled characters in file paths:

```sql
ALTER DATABASE silverfilesystem CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

### Large Dataset Performance

For very large file systems:
- Consider increasing `innodb_buffer_pool_size`
- Use partitioning for the `scanned_files` table
- Archive old scans regularly

## Security Best Practices

1. **Use Strong Passwords** - Never use empty or weak passwords
2. **Limited Privileges** - Create a dedicated user with only necessary permissions
3. **Secure Credentials** - Use environment variables, not command-line options
4. **Network Security** - Use localhost or secure connections (SSL)
5. **Regular Backups** - Backup database regularly

## Integration Examples

### Grafana Dashboard

Create visualizations by connecting Grafana to your MySQL database:
- File system growth over time
- Duplicate file trends
- Storage usage by file type
- Scan history timeline

### Scheduled Scans

Use cron for regular scanning:

```bash
# /etc/cron.d/silverfs-scan
0 2 * * 0 /usr/bin/node /path/to/silverfs/bin/cli.js scan /data --db
```

### Alerting

Create alerts for disk space issues:

```sql
-- Find if wasted space exceeds threshold
SELECT SUM(wasted_space) / 1024 / 1024 / 1024 as wasted_gb
FROM duplicate_groups
HAVING wasted_gb > 100; -- Alert if >100GB wasted
```

## Conclusion

The database integration provides powerful capabilities for tracking, analyzing, and managing your file system over time. Combined with SQL's querying capabilities, you can generate detailed reports and insights about your storage usage.
