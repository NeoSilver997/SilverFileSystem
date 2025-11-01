# Query Comparison: Before vs After Normalization

## 1. Finding Duplicate Folders

### Before (Path String Parsing)
```sql
-- Complex string manipulation to extract folder paths
SELECT
  LEFT(REPLACE(path, '\\', '/'), 
       CHAR_LENGTH(REPLACE(path, '\\', '/')) - 
       CHAR_LENGTH(SUBSTRING_INDEX(REPLACE(path, '\\', '/'), '/', -1)) - 1) as folder_path,
  COUNT(DISTINCT path) as file_count,
  SUM(size) as total_size,
  GROUP_CONCAT(DISTINCT CONCAT(name, '|', size, '|', IFNULL(hash, 'NULL')) 
               ORDER BY name SEPARATOR '###') as files_signature
FROM scanned_files
WHERE size >= 0 AND path LIKE '%\\%'
GROUP BY folder_path
HAVING file_count > 0;
```

### After (Normalized Structure)
```sql
-- Simple JOIN with pre-computed folder information
SELECT
  f.id as folder_id,
  f.folder_name,
  f.normalized_path,
  f.file_count,
  f.total_size,
  GROUP_CONCAT(DISTINCT CONCAT(sf.name, '|', sf.size, '|', IFNULL(sf.hash, 'NULL')) 
               ORDER BY sf.name SEPARATOR '###') as files_signature
FROM folders f
INNER JOIN scanned_files sf ON f.id = sf.folder_id
WHERE sf.size >= 0
GROUP BY f.id, f.folder_name, f.normalized_path, f.file_count, f.total_size
HAVING f.file_count > 0;
```

## 2. Getting Files by Folder

### Before (String Operations)
```sql
-- Extract folder path for each file at query time
SELECT *,
  LEFT(REPLACE(path, '\\', '/'), 
       CHAR_LENGTH(REPLACE(path, '\\', '/')) - 
       CHAR_LENGTH(SUBSTRING_INDEX(REPLACE(path, '\\', '/'), '/', -1)) - 1) as folder_path
FROM scanned_files
WHERE path LIKE '%Documents%'
ORDER BY folder_path, name;
```

### After (Direct JOIN)
```sql
-- Direct relationship, no string parsing needed
SELECT sf.*, f.folder_name, f.normalized_path, f.file_count, f.total_size
FROM scanned_files sf
JOIN folders f ON sf.folder_id = f.id
WHERE f.normalized_path LIKE '%Documents%'
ORDER BY f.normalized_path, sf.name;
```

## 3. Folder Statistics

### Before (Calculate Every Time)
```sql
-- Must calculate folder stats on every query
SELECT 
  LEFT(REPLACE(path, '\\', '/'), 
       CHAR_LENGTH(REPLACE(path, '\\', '/')) - 
       CHAR_LENGTH(SUBSTRING_INDEX(REPLACE(path, '\\', '/'), '/', -1)) - 1) as folder_path,
  COUNT(*) as file_count,
  SUM(size) as total_size,
  AVG(size) as avg_size,
  MAX(size) as largest_file
FROM scanned_files
GROUP BY folder_path
ORDER BY total_size DESC;
```

### After (Pre-calculated + Real-time)
```sql
-- Use cached statistics for base info, calculate additional as needed
SELECT 
  f.normalized_path,
  f.file_count,      -- Pre-calculated and cached
  f.total_size,      -- Pre-calculated and cached
  f.total_size / f.file_count as avg_size,  -- Calculated from cached values
  MAX(sf.size) as largest_file              -- Only this needs real calculation
FROM folders f
LEFT JOIN scanned_files sf ON f.id = sf.folder_id
GROUP BY f.id, f.normalized_path, f.file_count, f.total_size
ORDER BY f.total_size DESC;
```

## 4. Folder Hierarchy Queries

### Before (Not Possible Efficiently)
```sql
-- Very complex recursive string operations needed
-- Performance is poor for deep hierarchies
WITH RECURSIVE folder_tree AS (
  SELECT DISTINCT 
    LEFT(REPLACE(path, '\\', '/'), 
         CHAR_LENGTH(REPLACE(path, '\\', '/')) - 
         CHAR_LENGTH(SUBSTRING_INDEX(REPLACE(path, '\\', '/'), '/', -1)) - 1) as folder_path,
    1 as level
  FROM scanned_files
  -- Complex recursive logic here...
)
SELECT * FROM folder_tree;
```

### After (Native Hierarchy Support)
```sql
-- Simple recursive CTE with proper foreign keys
WITH RECURSIVE folder_hierarchy AS (
  -- Base case: root folders
  SELECT id, folder_name, normalized_path, parent_folder_id, 1 as level
  FROM folders 
  WHERE parent_folder_id IS NULL
  
  UNION ALL
  
  -- Recursive case: child folders
  SELECT f.id, f.folder_name, f.normalized_path, f.parent_folder_id, fh.level + 1
  FROM folders f
  INNER JOIN folder_hierarchy fh ON f.parent_folder_id = fh.id
)
SELECT * FROM folder_hierarchy ORDER BY level, normalized_path;
```

## 5. Performance Improvements

### Index Usage Before vs After

#### Before (String-based queries)
- Index on `path(255)` - Limited effectiveness
- Full table scans for folder operations
- String functions prevent index usage
- No caching of calculated values

#### After (Normalized structure)
- `idx_folder_id` - Direct foreign key lookup
- `idx_normalized_path` - Efficient folder searches  
- `idx_parent_folder` - Fast hierarchy traversal
- Cached `file_count` and `total_size` - No recalculation needed

### Query Execution Time Estimates

For a database with 1M files in 10K folders:

| Operation | Before | After | Improvement |
|-----------|--------|-------|-------------|
| Find duplicate folders | 15-30 sec | 2-5 sec | 3-6x faster |
| Get folder statistics | 10-20 sec | 0.1-0.5 sec | 20-200x faster |
| List files by folder | 5-10 sec | 0.1-1 sec | 5-100x faster |
| Folder hierarchy | Very slow/impossible | 0.1-1 sec | New capability |

## 6. Storage Efficiency

### Before
```
File 1: /very/long/folder/path/to/documents/file1.txt (50+ chars)
File 2: /very/long/folder/path/to/documents/file2.txt (50+ chars)
File 3: /very/long/folder/path/to/documents/file3.txt (50+ chars)
```
Total path storage: ~150 characters for 3 files

### After
```
Folder: id=1, normalized_path="/very/long/folder/path/to/documents" (40 chars, stored once)
File 1: folder_id=1, name="file1.txt" (4 bytes + filename)
File 2: folder_id=1, name="file2.txt" (4 bytes + filename)  
File 3: folder_id=1, name="file3.txt" (4 bytes + filename)
```
Total path storage: ~40 characters + 12 bytes for folder references

**Space savings: ~75% reduction in path storage for folders with multiple files**

## Migration Impact

The migration process will:

1. **Analyze existing data**: Extract unique folder paths
2. **Create normalized structure**: Build folder hierarchy with IDs
3. **Update file references**: Link files to folder IDs
4. **Calculate statistics**: Pre-compute file counts and sizes
5. **Maintain compatibility**: Keep original paths for backward compatibility

This provides immediate performance benefits while maintaining full backward compatibility with existing code.