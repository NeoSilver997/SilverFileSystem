# Duplicate Files Detection Workflow

This guide demonstrates the complete workflow for detecting and reporting duplicate files using SilverFileSystem's database features.

## Overview

SilverFileSystem provides a powerful workflow for managing duplicate files:

1. **Scan** - Scan directories and store file information in database
2. **Update Hashes** - Calculate file hashes for duplicate detection
3. **Find Duplicates** - Query duplicate files from database
4. **Generate Report** - Create interactive HTML reports

## Prerequisites

- MySQL database configured and running
- Database credentials configured in `config.json` or environment variables

## Complete Workflow

### Step 1: Initial Scan

Scan your directories and store file information in the database:

```bash
# Scan a single directory
node bin/cli.js scan /path/to/folder --db

# Scan multiple directories (separate scans)
node bin/cli.js scan /path/to/documents --db
node bin/cli.js scan /path/to/downloads --db
node bin/cli.js scan /path/to/pictures --db
```

**What happens:**
- Files are scanned recursively
- File metadata (path, size, timestamps) is stored in database
- Hashes are NOT calculated yet (to save time during initial scan)

### Step 2: Update File Hashes

Calculate hashes for files that don't have them yet:

```bash
# Update hashes for all files
node bin/cli.js update-hashes-db

# Update only larger files (more likely to be significant duplicates)
node bin/cli.js update-hashes-db -m 1048576  # Files > 1MB

# Limit processing for testing
node bin/cli.js update-hashes-db -l 1000  # Process max 1000 files
```

**What happens:**
- Queries database for files without hashes
- Calculates SHA-256 hash for each file
- Updates database with calculated hashes
- Shows progress and error count

**Note:** Files that no longer exist on disk will be skipped with a warning.

### Step 3: Find Duplicates from Database

Query duplicate files directly from the database:

```bash
# Find all duplicates
node bin/cli.js find-duplicates-db

# Find duplicates with minimum size filter
node bin/cli.js find-duplicates-db -m 10485760  # Files > 10MB

# Find duplicates and generate HTML report
node bin/cli.js find-duplicates-db --report duplicates-report.html
```

**What happens:**
- Queries database for files with identical hashes
- Groups duplicates together
- Calculates wasted space
- Displays results in console
- Optionally generates HTML report

### Step 4: Generate Interactive HTML Report

Create a beautiful, interactive HTML report:

```bash
# Generate report from database
node bin/cli.js generate-report duplicates.html

# Generate report with size filter
node bin/cli.js generate-report large-duplicates.html -m 10485760

# Custom database connection
node bin/cli.js generate-report report.html \
  --db-host localhost \
  --db-user myuser \
  --db-password mypass
```

**Report Features:**
- 📊 Summary statistics (groups, files, wasted space)
- 🔍 Real-time search functionality
- 📁 Collapsible duplicate groups
- 🔄 Sort by size or count
- 📅 File modification dates
- 🎨 Beautiful gradient design
- 📱 Mobile responsive

## Example: Complete Workflow

Here's a complete example from start to finish:

```bash
# 1. Scan your important directories
echo "Step 1: Scanning directories..."
node bin/cli.js scan /home/user/Documents --db
node bin/cli.js scan /home/user/Downloads --db
node bin/cli.js scan /home/user/Pictures --db

# 2. Update hashes for files larger than 100KB
echo "Step 2: Calculating hashes..."
node bin/cli.js update-hashes-db -m 102400

# 3. Find duplicates and generate report
echo "Step 3: Finding duplicates and generating report..."
node bin/cli.js find-duplicates-db --report ~/duplicates-$(date +%Y%m%d).html

echo "Done! Open the HTML report to review duplicates."
```

## Advanced Usage

### Incremental Updates

Add new scans without recalculating existing hashes:

```bash
# Scan new directory
node bin/cli.js scan /new/directory --db

# Update hashes only for new files
node bin/cli.js update-hashes-db
```

### Scheduled Scanning

Use cron for regular duplicate detection:

```bash
# /etc/cron.d/duplicate-scan
# Run every Sunday at 2 AM
0 2 * * 0 /usr/bin/node /path/to/silverfs/bin/cli.js scan /data --db
0 3 * * 0 /usr/bin/node /path/to/silverfs/bin/cli.js update-hashes-db
0 4 * * 0 /usr/bin/node /path/to/silverfs/bin/cli.js generate-report /var/www/duplicates.html
```

### Filter by File Size

Focus on files that matter:

```bash
# Only process files > 1MB (1048576 bytes)
node bin/cli.js update-hashes-db -m 1048576

# Only report duplicates > 10MB (10485760 bytes)
node bin/cli.js find-duplicates-db -m 10485760 --report large-duplicates.html
```

### Database Queries

You can also query the database directly:

```sql
-- Find duplicate groups
SELECT hash, COUNT(*) as count, size, 
       (COUNT(*) - 1) * size / 1024 / 1024 as wasted_mb
FROM scanned_files
WHERE hash IS NOT NULL
GROUP BY hash, size
HAVING count > 1
ORDER BY wasted_mb DESC;

-- Get all files in a duplicate group
SELECT path, size, mtime
FROM scanned_files
WHERE hash = 'your-hash-here'
ORDER BY path;

-- Files without hashes yet
SELECT COUNT(*) as files_without_hash
FROM scanned_files
WHERE hash IS NULL;

-- Total wasted space
SELECT SUM((count - 1) * size) / 1024 / 1024 / 1024 as wasted_gb
FROM (
  SELECT hash, COUNT(*) as count, size
  FROM scanned_files
  WHERE hash IS NOT NULL
  GROUP BY hash, size
  HAVING count > 1
) duplicates;
```

## Tips and Best Practices

### 1. Start Small
Test with a small directory first to understand the workflow:

```bash
node bin/cli.js scan /home/user/test-folder --db
node bin/cli.js update-hashes-db -l 100
node bin/cli.js find-duplicates-db --report test-report.html
```

### 2. Use Size Filters
Skip small files to focus on significant duplicates:

```bash
# Only hash files > 1MB
node bin/cli.js update-hashes-db -m 1048576

# Only report duplicates > 10MB
node bin/cli.js find-duplicates-db -m 10485760
```

### 3. Incremental Processing
Process files in batches:

```bash
# Process 1000 files at a time
node bin/cli.js update-hashes-db -l 1000

# Run multiple times to process all files
```

### 4. Monitor Progress
Watch the console output for:
- Number of files processed
- Errors (files not found)
- Wasted space calculations

### 5. Review Reports Regularly
Generate reports periodically to track:
- New duplicates over time
- Space that can be recovered
- File organization issues

## Troubleshooting

### No Duplicates Found

If no duplicates are found:

1. Check if hashes are calculated:
   ```sql
   SELECT COUNT(*) FROM scanned_files WHERE hash IS NOT NULL;
   ```

2. Update hashes if needed:
   ```bash
   node bin/cli.js update-hashes-db
   ```

3. Check size filter isn't too restrictive

### Files Not Found Errors

If you get "file not found" errors during hash updates:

- Files may have been moved or deleted since scanning
- Re-scan the directory to update the database:
  ```bash
  node bin/cli.js scan /path/to/folder --db
  ```

### Database Connection Issues

If you can't connect to database:

1. Check MySQL is running:
   ```bash
   sudo systemctl status mysql
   ```

2. Verify credentials in `config.json`

3. Test connection:
   ```bash
   mysql -h localhost -u username -p database_name
   ```

### Performance Issues

If processing is slow:

1. Use size filters to skip small files
2. Process files in batches with `-l` option
3. Ensure database has proper indexes (created automatically)
4. Consider hardware: hash calculation is CPU-intensive

## Next Steps

After identifying duplicates:

1. **Review** - Open the HTML report and review duplicate groups
2. **Verify** - Manually check files before deleting
3. **Clean Up** - Delete unnecessary duplicates (manual process for safety)
4. **Re-scan** - Run another scan after cleanup to verify

## Security Note

⚠️ **Important**: SilverFileSystem NEVER deletes files automatically. All file management (moving, deleting) must be done manually by the user. This is a safety feature to prevent accidental data loss.

## Conclusion

The database-driven workflow provides efficient duplicate detection:

- ✅ Scan files once, query many times
- ✅ No re-scanning needed for duplicate checks
- ✅ Fast queries on indexed database
- ✅ Beautiful HTML reports for review
- ✅ Safe - read-only operations

For more information, see:
- [README.md](README.md) - General usage
- [DATABASE.md](DATABASE.md) - Database setup and queries
- [EXAMPLES.md](EXAMPLES.md) - More usage examples
