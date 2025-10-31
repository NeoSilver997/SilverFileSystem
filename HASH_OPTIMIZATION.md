# Hash Optimization Guide

## Smart Hash Optimization (Default)

The `update-hashes-db` command now includes **smart optimization enabled by default** that dramatically improves performance by only hashing files that can actually be duplicates.

### Problem
Calculating hashes for files is expensive and time-consuming. However, many files have unique sizes and cannot possibly have duplicates (two files can only be duplicates if they have the same size). Hashing these unique-sized files provides no benefit for duplicate detection.

### Solution
**Smart optimization (enabled by default)** only calculates hashes for files when there are multiple files of the same size (potential duplicates). Files with unique sizes are automatically skipped.

## Usage

### Smart Optimization (Default)
Smart optimization is **enabled by default**. The system automatically only hashes files that have the same size as other files:

```bash
# Smart optimization is automatic (only hashes potential duplicates)
node bin/cli.js update-hashes-db

# Show statistics about what will be skipped
node bin/cli.js update-hashes-db --stats

# Hash all files regardless of size (disable optimization)
node bin/cli.js update-hashes-db --no-smart
```

### Combined with Other Options
```bash
# Smart optimization with quick hashing
node bin/cli.js update-hashes-db --hash-method quick

# Smart optimization with size filters
node bin/cli.js update-hashes-db --min-size 1048576

# Show optimization impact before processing
node bin/cli.js update-hashes-db --stats --min-size 1048576 --max-size 1073741824
```

### Disable Optimization
If you need to hash ALL files (including those with unique sizes):

```bash
# Disable smart optimization
node bin/cli.js update-hashes-db --no-smart
```

## Performance Benefits

Smart optimization typically provides dramatic performance improvements:
- **Only hashes files with same size** - skips all unique-sized files
- **Typically 30-70% fewer files** need to be processed (varies by dataset)
- **Significant time savings** especially with full hash methods
- **No loss in accuracy** - all potential duplicates are still detected

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
# Smart optimization is automatic - only hashes potential duplicates
node bin/cli.js update-hashes-db --hash-method smart
```

**Check optimization impact first:**
```bash
# See how many files will be skipped before processing
node bin/cli.js update-hashes-db --stats
```

**Quick duplicate check:**
```bash
# Smart optimization + quick hashing for speed
node bin/cli.js update-hashes-db --hash-method quick -l 1000
```

**High accuracy for important files:**
```bash
# Smart optimization + sampling for accuracy
node bin/cli.js update-hashes-db --hash-method sampling --max-size 1073741824
```

**Handle very large files:**
```bash
# Smart optimization + streaming for large files
node bin/cli.js update-hashes-db --hash-method streaming --min-size 2147483648
```

**Hash everything (disable optimization):**
```bash
# Use --no-smart to hash all files, even those with unique sizes
node bin/cli.js update-hashes-db --no-smart
```

## Optimization Logic

The smart optimization works by analyzing file sizes:

1. **Files with duplicate sizes**: Process (potential duplicates exist)
2. **Files with unique sizes**: Skip (cannot have duplicates)

**Key Insight:** Two files can only be duplicates if they have the same size. By grouping files by size first, we can immediately skip all files with unique sizes without computing their hashes.

This dramatically reduces processing time while maintaining 100% duplicate detection accuracy - no false negatives.

## Statistics

Use the `--stats` flag to see optimization impact before processing:

```bash
# Show optimization statistics
node bin/cli.js update-hashes-db --stats

# Show statistics for specific size range
node bin/cli.js update-hashes-db --stats --min-size 1048576 --max-size 1073741824
```

Example output:
```
📊 Smart Hashing Optimization Statistics:
   Total files without hash: 10,000
   Files with potential duplicates (will process): 3,500
   Files with unique size (will skip): 6,500 (65.0%)
```

This shows that smart optimization will skip 65% of files, dramatically reducing processing time while still detecting all duplicates.