# File Size and Name Reporting

The `report-by-size` command provides flexible reporting of files grouped by size and name, making it easy to identify potential duplicates and space usage patterns.

## Basic Usage

```bash
# Basic report of files with same size and name
node bin/cli.js report-by-size

# Show only files larger than 10MB
node bin/cli.js report-by-size --min-size 10485760

# Limit to top 20 results
node bin/cli.js report-by-size -l 20
```

## Report Formats

### Table Format (Default)
```bash
node bin/cli.js report-by-size --min-size 1000000 -l 10
```
Shows a formatted table with file names, sizes, counts, and sample paths.

### JSON Format
```bash
node bin/cli.js report-by-size --format json --min-size 1000000 -l 5
```
Outputs structured JSON data for programmatic processing.

### CSV Format
```bash
node bin/cli.js report-by-size --format csv --min-size 1000000 -l 10
```
Generates CSV output for spreadsheet analysis.

## Filtering Options

### Names Only (No Paths)
```bash
node bin/cli.js report-by-size --names-only --min-size 1000000
```
Shows only filename and size information without displaying full paths.

### Group by Size Only
```bash
node bin/cli.js report-by-size --sizes-only --min-size 10000000
```
Groups files by size regardless of filename - useful for finding files that might be duplicates with different names.

## Common Use Cases

### Find Large Duplicate Media Files
```bash
node bin/cli.js report-by-size --names-only --min-size 100000000 -l 20
```

### Export Duplicate Analysis to Spreadsheet
```bash
node bin/cli.js report-by-size --format csv --min-size 1000000 > duplicates.csv
```

### Quick Overview of Space Wasters
```bash
node bin/cli.js report-by-size --names-only -l 10
```

### Programmatic Processing
```bash
node bin/cli.js report-by-size --format json --min-size 50000000 > analysis.json
```

## Output Information

Each report includes:
- **File name** (exact filename)
- **File size** (in bytes and human-readable format)
- **Count** (number of copies found)
- **Wasted space** (size × (count - 1))
- **Paths** (sample locations where files are found)

## Summary Statistics

All reports include summary information:
- Total number of duplicate groups
- Total number of files involved
- Total wasted space across all duplicates

## Performance Tips

- Use `--min-size` to focus on larger files that waste more space
- Use `-l` to limit results for faster processing
- Use `--names-only` for quicker reports when paths aren't needed
- Combine with other database options for specific database configurations

## Examples

### Find All Video Files That Might Be Duplicates
```bash
# Large files (likely videos) with same names
node bin/cli.js report-by-size --names-only --min-size 500000000 -l 25

# All large files regardless of name
node bin/cli.js report-by-size --sizes-only --min-size 500000000 -l 25
```

### Generate Complete Duplicate Analysis
```bash
# Full report with paths
node bin/cli.js report-by-size --min-size 1000000

# Export for further analysis
node bin/cli.js report-by-size --format csv --min-size 1000000 > duplicate_analysis.csv
```