# Folder-Grouped HTML Duplicate Reports

The `report-by-folder` command generates beautiful, interactive HTML reports showing duplicate files organized by their containing folders. This provides a clear view of which directories contain the most duplicates and wasted space.

## Features

### 📁 **Folder Organization**
- Groups duplicate files by their parent directory
- Shows folder-level statistics (file count, wasted space)
- Sorted by wasted space (most problematic folders first)

### 🎨 **Interactive Design**
- Modern, responsive web interface
- Collapsible folder sections
- Auto-expand folders with significant wasted space (>100MB)
- Beautiful gradient styling and hover effects

### 📊 **Comprehensive Statistics**
- Overall statistics at the top (folders, files, total waste)
- Per-folder statistics (files, wasted space)
- Per-duplicate-group details (copies, hash, size)

## Usage

### Basic Folder Report
```bash
node bin/cli.js report-by-folder duplicates-by-folder.html
```

### Large Files Only
```bash
node bin/cli.js report-by-folder large-folder-duplicates.html --min-size 100000000
```

### Custom Database Connection
```bash
node bin/cli.js report-by-folder folder-report.html \
  --db-host localhost \
  --db-user myuser \
  --db-password mypass
```

## Report Structure

### Header Section
- Title and description
- Key statistics cards:
  - **Folders with Duplicates**: Number of directories containing duplicate files
  - **Duplicate Files**: Total count of duplicate files
  - **Total Wasted Space**: Cumulative space that could be reclaimed

### Folder Groups
Each folder section contains:
- **Folder Path**: Full directory path
- **Folder Statistics**: File count and wasted space for this folder
- **Duplicate Groups**: Files with identical content (same hash)
- **File Details**: Individual file listings with full paths

### Interactive Features
- **Click folder headers** to expand/collapse content
- **Auto-expansion** for folders with >100MB wasted space
- **Hover effects** for better visual feedback
- **Responsive design** works on desktop and mobile

## Example Output

```
📁 Report saved to: folder-duplicates.html

📊 Statistics:
   Folders with duplicates: 822
   Total duplicate files: 5,277
   Total wasted space: 248.55 GB

🔥 Top folders by wasted space:
   1. D:\Photo\128G\100MEDIAa: 16 GB
   2. D:\Photo\htc10_2016\2017: 15.68 GB
   3. D:\Videos: 15.27 GB
   4. D:\Photo\JennyiPhone7: 15.04 GB
   5. D:\Photo\Jenny's Plus: 12.64 GB
```

## Use Cases

### 🎯 **Photo Library Cleanup**
```bash
node bin/cli.js report-by-folder photo-duplicates.html --min-size 1000000
```
Perfect for identifying duplicate photos across different folders and backup locations.

### 🎬 **Video Collection Analysis**
```bash
node bin/cli.js report-by-folder video-duplicates.html --min-size 100000000
```
Find large video files that are duplicated across multiple directories.

### 💾 **Backup Verification**
```bash
node bin/cli.js report-by-folder backup-analysis.html --min-size 10000000
```
Identify which backup folders contain identical files and may be redundant.

### 📂 **Folder-by-Folder Cleanup**
The folder grouping makes it easy to:
- Focus cleanup efforts on specific directories
- Understand duplication patterns by location
- Prioritize folders with the most wasted space
- Plan folder reorganization strategies

## Technical Details

### Database Query
The report uses an optimized SQL query that:
- Groups files by directory path
- Identifies duplicates using file hashes
- Calculates per-folder statistics
- Sorts by wasted space for priority focus

### HTML Generation
- Modern CSS Grid and Flexbox layouts
- JavaScript for interactive expand/collapse
- Responsive design principles
- Semantic HTML structure
- Cross-browser compatibility

### Performance
- Efficient database grouping
- Lazy loading of folder content (collapsed by default)
- Auto-expansion only for high-impact folders
- Optimized for large datasets (tested with 5,000+ files)

## Comparison with Other Reports

| Report Type | Best For | Grouping | Format |
|-------------|----------|----------|---------|
| `duplicates` | Quick CLI overview | By hash | Terminal |
| `report-by-size` | Size analysis | By size/name | Table/JSON/CSV |
| `generate-report` | Full details | By hash | HTML |
| `report-by-folder` | Location analysis | By folder | HTML |

## Tips

1. **Start with large files** (`--min-size 100000000`) to focus on significant space savings
2. **Use the auto-expansion feature** - folders with >100MB waste open automatically
3. **Focus on top folders** shown in the CLI summary for maximum impact
4. **Share the HTML report** with others - it's self-contained and portable
5. **Use different size thresholds** for different types of analysis