# SilverFileSystem - Usage Examples

This document provides practical examples for using SilverFileSystem to manage files across your network.

## Quick Start Examples

### 1. Get a Directory Overview

Before diving into specific tasks, get an overview of what's in a directory:

```bash
node bin/cli.js scan /home/user/documents
```

This will show:
- Total number of files
- Total size
- Number of empty files
- Top file types by size

### 2. Clean Up Disk Space

#### Find and Review Large Files

```bash
# Find files larger than 1GB
node bin/cli.js large-files /home/user -m 1000 -l 20

# Find all files larger than 500MB across multiple drives
node bin/cli.js large-files /mnt/drive1 /mnt/drive2 -m 500
```

#### Find Duplicate Files

```bash
# Find all duplicate files
node bin/cli.js duplicates /home/user/documents

# Find duplicate files larger than 10MB (10485760 bytes)
node bin/cli.js duplicates /home/user/documents -m 10485760

# Search for duplicates across multiple directories
node bin/cli.js duplicates /home/user/photos /media/backup/photos
```

#### Find Empty Files and Directories

```bash
# Find empty files
node bin/cli.js empty-files /home/user/documents

# Find empty directories
node bin/cli.js empty-dirs /home/user/documents

# Clean up empty items in multiple locations
node bin/cli.js empty-files /home/user /var/tmp /opt/data
```

### 3. Maintenance and File Integrity

#### Check for Broken Symbolic Links

```bash
# Find broken symlinks
node bin/cli.js broken-symlinks /home/user

# Check system-wide (requires appropriate permissions)
node bin/cli.js broken-symlinks /usr/local /opt
```

#### Find Files with Invalid Names

```bash
# Find files with problematic names
node bin/cli.js invalid-names /home/user/documents

# Useful for preparing files for transfer to Windows
node bin/cli.js invalid-names /mnt/linux-share
```

## Network File Management

### Windows Network Shares

```bash
# Scan a network share
node bin/cli.js scan "\\\\server\\shared\\documents"

# Find duplicates across network
node bin/cli.js duplicates "\\\\server\\shared" "\\\\backup-server\\shared"

# Find large files on network drive
node bin/cli.js large-files "\\\\nas\\media" -m 100
```

### Linux/Mac Network Mounts

```bash
# Scan mounted NFS or CIFS share
node bin/cli.js scan /mnt/network/documents

# Find duplicates between local and network
node bin/cli.js duplicates /home/user/photos /mnt/network/photos-backup

# Find large files on network
node bin/cli.js large-files /mnt/nas/videos -m 500 -l 30
```

## Real-World Scenarios

### Scenario 1: Photo Library Cleanup

You have photos scattered across multiple folders and want to find duplicates:

```bash
# Step 1: Get overview
node bin/cli.js scan /home/user/Pictures

# Step 2: Find duplicates (skip files smaller than 100KB to focus on photos)
node bin/cli.js duplicates /home/user/Pictures -m 102400

# Step 3: Find large images
node bin/cli.js large-files /home/user/Pictures -m 10 -l 50
```

### Scenario 2: Server Maintenance

Clean up a server that's running low on disk space:

```bash
# Find the biggest space consumers
node bin/cli.js large-files /var /home /opt -m 100 -l 50

# Find empty log files
node bin/cli.js empty-files /var/log

# Find duplicate backup files
node bin/cli.js duplicates /backup -m 1048576
```

### Scenario 3: Network Storage Audit

Audit network storage to identify optimization opportunities:

```bash
# Overview of network storage
node bin/cli.js scan /mnt/network-storage

# Find duplicate files wasting space
node bin/cli.js duplicates /mnt/network-storage -m 1048576

# Identify largest files
node bin/cli.js large-files /mnt/network-storage -m 50 -l 100

# Find broken symlinks
node bin/cli.js broken-symlinks /mnt/network-storage
```

### Scenario 4: Cross-Platform File Preparation

Preparing files to move from Linux to Windows:

```bash
# Find files with names that won't work on Windows
node bin/cli.js invalid-names /home/user/project

# Find empty directories to clean up
node bin/cli.js empty-dirs /home/user/project

# Check for broken symlinks (Windows doesn't handle them well)
node bin/cli.js broken-symlinks /home/user/project
```

## Advanced Tips

### Combining Commands

You can use shell scripting to combine commands:

```bash
#!/bin/bash
# Comprehensive disk cleanup script

echo "=== Directory Overview ==="
node bin/cli.js scan /home/user

echo -e "\n=== Finding Duplicates ==="
node bin/cli.js duplicates /home/user -m 1048576

echo -e "\n=== Finding Large Files ==="
node bin/cli.js large-files /home/user -m 100 -l 20

echo -e "\n=== Finding Empty Files ==="
node bin/cli.js empty-files /home/user

echo -e "\n=== Finding Empty Directories ==="
node bin/cli.js empty-dirs /home/user
```

### Using with Cron for Regular Audits

```bash
# Add to crontab for weekly network storage audit
0 2 * * 0 /usr/bin/node /path/to/silverfs/bin/cli.js scan /mnt/network > /var/log/storage-audit.log
```

### Performance Optimization

For large directories, use appropriate options:

```bash
# Use minimum size to skip small files when looking for duplicates
node bin/cli.js duplicates /large/directory -m 10485760

# Limit results for faster execution
node bin/cli.js large-files /large/directory -m 100 -l 20
```

## Output Interpretation

### Understanding Duplicate Reports

When duplicates are found, you'll see:
- **Group number**: Each set of identical files
- **File count**: Number of duplicate copies
- **File size**: Size of each duplicate
- **Wasted space**: Total space that could be freed by keeping only one copy

### Understanding Size Reports

File sizes are shown in human-readable format:
- Bytes: 0-1023 bytes
- KB: Kilobytes (1024 bytes)
- MB: Megabytes (1024 KB)
- GB: Gigabytes (1024 MB)
- TB: Terabytes (1024 GB)

## Troubleshooting

### Permission Denied Errors

If you see "Warning: Could not access..." messages:
- Run with appropriate permissions (sudo if necessary)
- Check file/directory permissions
- Ensure network shares are properly mounted

### Network Timeouts

For slow network drives:
- Scan smaller subdirectories separately
- Use minimum size filters to reduce scanning time
- Consider running scans during off-peak hours

### Memory Issues

For very large directories:
- Use minimum size filters
- Limit the number of results
- Scan subdirectories separately

## Database and Reporting Examples

### Using Database for Persistent Duplicate Detection

#### 1. Initial Setup and Scan

Store file information in database for later analysis:

```bash
# Configure database (one-time setup)
export DB_HOST=localhost
export DB_USER=root
export DB_PASSWORD=yourpassword
export DB_NAME=silverfilesystem

# Scan directories and store to database
node bin/cli.js scan /home/user/documents --db
node bin/cli.js scan /home/user/downloads --db
node bin/cli.js scan /home/user/pictures --db
```

#### 2. Update File Hashes

Calculate hashes for duplicate detection:

```bash
# Update hashes for all files in database
node bin/cli.js update-hashes-db

# Update only files larger than 1MB
node bin/cli.js update-hashes-db -m 1048576

# Process in batches (useful for large datasets)
node bin/cli.js update-hashes-db -l 5000
```

#### 3. Find Duplicates from Database

Query duplicates without re-scanning filesystem:

```bash
# Find all duplicates from database
node bin/cli.js find-duplicates-db

# Find duplicates with size filter
node bin/cli.js find-duplicates-db -m 10485760

# Find duplicates and generate HTML report
node bin/cli.js find-duplicates-db --report duplicates.html
```

#### 4. Generate Interactive HTML Reports

Create beautiful HTML reports:

```bash
# Basic report
node bin/cli.js generate-report duplicates.html

# Report with size filter (only large files)
node bin/cli.js generate-report large-duplicates.html -m 10485760

# Report with custom database
node bin/cli.js generate-report report.html \
  --db-host mysql.example.com \
  --db-user scanner \
  --db-password secret
```

### Complete Workflow Example

Here's a complete workflow for duplicate detection:

```bash
#!/bin/bash
# duplicate-detection.sh

# Step 1: Scan directories
echo "Scanning directories..."
node bin/cli.js scan /home/user/Documents --db
node bin/cli.js scan /home/user/Downloads --db
node bin/cli.js scan /media/backup --db

# Step 2: Calculate hashes (files > 100KB)
echo "Calculating hashes..."
node bin/cli.js update-hashes-db -m 102400

# Step 3: Generate report
echo "Generating report..."
REPORT_FILE="duplicates-$(date +%Y%m%d-%H%M%S).html"
node bin/cli.js generate-report "$REPORT_FILE"

echo "Report generated: $REPORT_FILE"
echo "Open in browser to review duplicates"
```

### Scheduled Duplicate Detection

Use cron for automatic duplicate detection:

```bash
# /etc/cron.d/duplicate-detection
# Run every Sunday at 2 AM

# Scan directories
0 2 * * 0 cd /path/to/silverfs && node bin/cli.js scan /data/documents --db
5 2 * * 0 cd /path/to/silverfs && node bin/cli.js scan /data/media --db

# Update hashes
0 3 * * 0 cd /path/to/silverfs && node bin/cli.js update-hashes-db -m 1048576

# Generate weekly report
0 4 * * 0 cd /path/to/silverfs && node bin/cli.js generate-report /var/www/html/duplicates.html
```

### Advanced Database Queries

Query the database directly for custom analysis:

```sql
-- Find largest duplicate groups
SELECT hash, COUNT(*) as files, size, 
       ROUND((COUNT(*) - 1) * size / 1024 / 1024 / 1024, 2) as wasted_gb
FROM scanned_files
WHERE hash IS NOT NULL
GROUP BY hash, size
HAVING files > 1
ORDER BY wasted_gb DESC
LIMIT 20;

-- Find duplicate photos
SELECT sf.path, sf.size, sf.mtime
FROM scanned_files sf
WHERE sf.extension IN ('jpg', 'jpeg', 'png', 'gif')
  AND sf.hash IN (
    SELECT hash FROM scanned_files
    WHERE hash IS NOT NULL
    GROUP BY hash
    HAVING COUNT(*) > 1
  )
ORDER BY sf.hash, sf.path;

-- Statistics by file type
SELECT extension, 
       COUNT(*) as total_files,
       ROUND(SUM(size) / 1024 / 1024, 2) as total_mb,
       COUNT(DISTINCT hash) as unique_files
FROM scanned_files
WHERE extension IS NOT NULL
GROUP BY extension
ORDER BY total_mb DESC
LIMIT 20;
```

### Incremental Updates

Add new files without recalculating existing hashes:

```bash
# Scan new directory
node bin/cli.js scan /new/directory --db

# Update hashes only for new files (those without hashes)
node bin/cli.js update-hashes-db

# Regenerate report with all files
node bin/cli.js generate-report updated-duplicates.html
```

## HTML Report Features

The interactive HTML report includes:

- **Summary Statistics**: Total groups, files, and wasted space
- **Search**: Real-time filtering by file path or name
- **Expand/Collapse**: Show or hide file lists for each group
- **Sorting**: Sort by file size or count
- **File Details**: Path, modification date, and hash for each file
- **Responsive Design**: Works on desktop, tablet, and mobile
- **Beautiful UI**: Modern gradient design with smooth animations

### Opening Reports

```bash
# Linux
xdg-open duplicates.html

# macOS
open duplicates.html

# Windows
start duplicates.html

# Or just open in your browser
firefox duplicates.html
chrome duplicates.html
```

## Best Practices for Database Workflow

1. **Scan First, Hash Later**: Scanning is fast, hashing is slow. Scan all directories first, then calculate hashes.

2. **Use Size Filters**: Skip small files to focus on significant duplicates:
   ```bash
   node bin/cli.js update-hashes-db -m 1048576  # > 1MB
   ```

3. **Regular Updates**: Set up scheduled scans to track changes over time

4. **Backup Database**: Regular backups of your database preserve scan history

5. **Review Reports**: Generate reports periodically to identify cleanup opportunities

6. **Incremental Processing**: Process large datasets in batches:
   ```bash
   node bin/cli.js update-hashes-db -l 10000
   ```

## Conclusion

The database workflow provides powerful duplicate detection and reporting:

- ✅ Scan once, query many times
- ✅ Fast database queries vs filesystem scanning
- ✅ Historical tracking of files
- ✅ Beautiful HTML reports for review
- ✅ Scriptable and automatable

For more details, see:
- [DUPLICATE_WORKFLOW.md](DUPLICATE_WORKFLOW.md) - Complete workflow guide
- [DATABASE.md](DATABASE.md) - Database setup and queries
- [README.md](README.md) - General usage and features
