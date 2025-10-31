# Hash Optimization Guide

## Large File Hash Optimization

The `update-hashes-db` command now includes smart optimization for large files to significantly improve performance.

### Problem
Calculating hashes for very large files (>200MB) is expensive and time-consuming. Many large files are unique and don't have duplicates, so hashing them provides no benefit for duplicate detection.

### Solution
The `--optimize-large` flag only calculates hashes for large files when there are multiple files of the same size (potential duplicates).

## Usage

### Basic Optimization
```bash
# Only hash large files (>200MB) that have potential duplicates
node bin/cli.js update-hashes-db --optimize-large
```

### Custom Threshold
```bash
# Use 500MB as the large file threshold
node bin/cli.js update-hashes-db --optimize-large --large-threshold 524288000
```

### Combined with Other Options
```bash
# Optimize large files, use quick hashing, limit to 100 files
node bin/cli.js update-hashes-db --optimize-large --hash-method quick -l 100

# Optimize with size range
node bin/cli.js update-hashes-db --optimize-large --min-size 1048576 --max-size 10737418240
```

## Performance Benefits

Based on test data:
- **23.9% fewer large files** need to be processed
- **746 out of 3,120** large files can be skipped
- **Significant time savings** especially with full hash methods

### Hash Method Recommendations by File Size

| File Size | Recommended Method | Reason |
|-----------|-------------------|---------|
| < 1MB | `full` | Fast, complete accuracy |
| 1MB - 100MB | `sampling` | Good balance of speed/accuracy |
| 100MB - 2GB | `smart` (auto-selects `quick`) | Fast, sufficient for duplicates |
| > 2GB | `streaming` | Only method that works |

### Example Commands by Use Case

**Initial hash population (first time):**
```bash
node bin/cli.js update-hashes-db --optimize-large --hash-method smart
```

**Quick duplicate check:**
```bash
node bin/cli.js update-hashes-db --optimize-large --hash-method quick -l 1000
```

**High accuracy for important files:**
```bash
node bin/cli.js update-hashes-db --hash-method sampling --max-size 1073741824
```

**Handle very large files:**
```bash
node bin/cli.js update-hashes-db --hash-method streaming --min-size 2147483648
```

## Optimization Logic

The optimization works by:

1. **Small files** (< threshold): Always process
2. **Large files** (≥ threshold): Only process if multiple files exist with the same size
3. **Unique large files**: Skip (no potential duplicates)

This dramatically reduces processing time while maintaining complete duplicate detection accuracy.

## Statistics

Use this command to see optimization impact:
```bash
# Check how many files would be skipped
node -e "
import { DatabaseManager } from './lib/database.js';
import { loadConfig } from './lib/utils.js';
const config = loadConfig();
const db = new DatabaseManager(config.database);
await db.connect();
const stats = await db.getLargeFileStats();
console.log(\`Optimization would skip \${stats.largeFilesSkipped} out of \${stats.totalLargeFiles} large files (\${(stats.largeFilesSkipped/stats.totalLargeFiles*100).toFixed(1)}%)\`);
await db.close();
"
```