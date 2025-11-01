# SilverFileSystem - Normalized Database Structure

## Overview
The database has been restructured to normalize folder paths, eliminating redundancy and improving performance for folder-based operations.

## Table Structure

### 1. `folders` Table (NEW - Normalized Structure)
```sql
CREATE TABLE folders (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  parent_folder_id  INT NULL,                    -- Self-referencing for hierarchy
  folder_name       VARCHAR(512) NOT NULL,      -- Just the folder name (e.g., "Documents")
  full_path         VARCHAR(2048) NOT NULL UNIQUE, -- Original full path
  normalized_path   VARCHAR(2048) NOT NULL,     -- Normalized path (forward slashes)
  file_count        INT DEFAULT 0,              -- Cached count of files in folder
  total_size        BIGINT DEFAULT 0,           -- Cached total size of files in folder
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  FOREIGN KEY (parent_folder_id) REFERENCES folders(id) ON DELETE CASCADE,
  INDEX idx_parent_folder (parent_folder_id),
  INDEX idx_folder_name (folder_name),
  INDEX idx_full_path (full_path(255)),
  INDEX idx_normalized_path (normalized_path(255))
);
```

### 2. `scanned_files` Table (Updated with folder reference)
```sql
CREATE TABLE scanned_files (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  folder_id    INT,                           -- NEW: Reference to folders table
  path         VARCHAR(2048) NOT NULL,        -- Full file path (kept for compatibility)
  name         VARCHAR(512) NOT NULL,         -- File name
  size         BIGINT NOT NULL,               -- File size in bytes
  hash         VARCHAR(64),                   -- File content hash
  quick_hash   VARCHAR(64),                   -- Quick hash for large files
  extension    VARCHAR(255),                  -- File extension
  mtime        DATETIME,                      -- Modified time
  atime        DATETIME,                      -- Access time  
  ctime        DATETIME,                      -- Creation time
  scan_id      INT,                           -- Reference to scan session
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE SET NULL,
  INDEX idx_folder_id (folder_id),
  INDEX idx_path (path(255)),
  INDEX idx_size (size),
  INDEX idx_hash (hash),
  INDEX idx_quick_hash (quick_hash),
  INDEX idx_extension (extension),
  INDEX idx_scan_id (scan_id)
);
```

### 3. Other Existing Tables (Unchanged)
- `scan_sessions` - Track scanning operations
- `duplicate_groups` - Store duplicate file group information
- `photo_metadata` - EXIF data for photos
- `music_metadata` - ID3 tags for music files
- `video_metadata` - Metadata for video files

## Benefits of Normalized Structure

### 1. **Space Efficiency**
- **Before**: Each file stored complete folder path (redundant data)
  ```
  /home/user/Documents/Work/Project1/file1.txt
  /home/user/Documents/Work/Project1/file2.txt
  /home/user/Documents/Work/Project1/file3.txt
  ```
- **After**: Folder path stored once, files reference by ID
  ```
  folders: id=1, path="/home/user/Documents/Work/Project1"
  files: folder_id=1, name="file1.txt"
         folder_id=1, name="file2.txt"
         folder_id=1, name="file3.txt"
  ```

### 2. **Improved Performance**
- **Folder queries**: Direct JOIN instead of string parsing
- **Duplicate detection**: More efficient folder grouping
- **Cached statistics**: Pre-calculated file counts and sizes per folder

### 3. **Path Normalization**
- **Consistent separators**: All paths use forward slashes internally
- **Hierarchy support**: Parent-child relationships between folders
- **Cross-platform compatibility**: Windows/POSIX path handling

### 4. **Better Analytics**
- **Folder statistics**: Quick access to folder size and file count
- **Hierarchy analysis**: Easy traversal of folder trees
- **Duplicate folder detection**: More accurate identification

## Relationship Diagram

```
┌─────────────────┐         ┌──────────────────┐
│     folders     │◄────────│   scanned_files  │
├─────────────────┤         ├──────────────────┤
│ id (PK)         │         │ id (PK)          │
│ parent_folder_id│         │ folder_id (FK)   │
│ folder_name     │         │ path             │
│ full_path       │         │ name             │
│ normalized_path │         │ size             │
│ file_count      │         │ hash             │
│ total_size      │         │ extension        │
└─────────────────┘         │ mtime            │
         │                  │ scan_id          │
         │                  └──────────────────┘
         │ Self-referencing              │
         │ (parent-child)                │
         └───────────────────────────────┘
                                         │
                              ┌──────────────────┐
                              │  scan_sessions   │
                              ├──────────────────┤
                              │ id (PK)          │
                              │ scan_path        │
                              │ total_files      │
                              │ start_time       │
                              └──────────────────┘
```

## Key Methods Added

### Folder Management
- `normalizePath(path)` - Convert path separators to forward slashes
- `extractFolderPath(filePath)` - Get folder path from file path
- `extractFolderName(folderPath)` - Get folder name from path
- `findOrCreateFolder(folderPath)` - Find existing or create new folder
- `updateFolderStats(folderId)` - Update cached file count and size
- `getAllFolders()` - Get all folders with hierarchy information

### Enhanced File Storage
- `storeFileWithFolder(file, scanId)` - Store file with folder normalization
- `storeFilesBatchWithFolders(files, scanId)` - Batch insert with folders

### Migration
- `migrateFoldersNormalization()` - Migrate existing data to normalized structure

## Usage Examples

### 1. Store files with automatic folder creation:
```javascript
await db.storeFileWithFolder({
  path: "C:\\Users\\Data\\photos\\vacation\\img1.jpg",
  name: "img1.jpg", 
  size: 1048576
});
// Automatically creates folder hierarchy and links file
```

### 2. Query duplicates by folder efficiently:
```javascript
const duplicatesByFolder = await db.getDuplicatesByFolder(1000000);
// Returns organized by normalized folder structure
```

### 3. Find duplicate folders:
```javascript
const duplicateFolders = await db.getCompleteDuplicateFolders();
// Uses normalized folder signatures for accurate detection
```

## Migration Process

To migrate existing data to the new structure:

```bash
node bin/cli.js migrate-folders
```

This will:
1. Create the `folders` table
2. Extract unique folder paths from existing files
3. Create normalized folder records with hierarchy
4. Update `scanned_files` to reference folder IDs
5. Calculate and cache folder statistics

## Backward Compatibility

- All existing queries continue to work
- File paths are still stored in `scanned_files.path`
- New methods use normalized structure for better performance
- Migration is optional but recommended for large datasets