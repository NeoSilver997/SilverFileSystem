# Database Migration System

## Overview

SilverFileSystem now includes a robust database version tracking system to manage schema changes safely across different database versions. This ensures that database updates can be applied incrementally and idempotently.

## Version Tracking Table

The system uses a `db_version` table to track which migrations have been applied:

```sql
CREATE TABLE db_version (
  id INT AUTO_INCREMENT PRIMARY KEY,
  version INT NOT NULL UNIQUE,
  description VARCHAR(255),
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_version (version)
);
```

## Migration Versions

### Version 1: Initial Schema
**Applied by:** `initializeTables()`  
**Description:** Creates all base tables for the file system including:
- `scanned_files` - Core file information
- `scan_sessions` - Scan operation tracking
- `duplicate_groups` - Duplicate file information
- `photo_metadata` - Photo EXIF data
- `music_metadata` - Music ID3 tags
- `video_metadata` - Video metadata
- `users` - User authentication
- `music_ratings` - User ratings for music
- `music_play_history` - Play history tracking

### Version 2: Duplicate Tracking Enhancement
**Applied by:** `migrateToVersion2()`  
**Description:** Enhances duplicate tracking capabilities
- Updates `extension` column to VARCHAR(255) for longer extensions
- Adds `is_duplicate` BOOLEAN column to mark duplicate files
- Adds `duplicate_group_id` INT column to group duplicates
- Creates indexes for efficient duplicate queries

### Version 3: Folder Normalization
**Applied by:** `migrateToVersion3()`  
**Description:** Adds folder tracking for better organization
- Adds `folder_id` VARCHAR(512) column to track file folders
- Creates index on `folder_id` for efficient folder queries
- Prepares for future folder normalization features

## API Methods

### Core Version Management

#### `createVersionTable()`
Creates the `db_version` table if it doesn't exist.

```javascript
await db.createVersionTable();
```

#### `getCurrentVersion()`
Returns the current database schema version as an integer (0 if no migrations applied).

```javascript
const version = await db.getCurrentVersion();
console.log(`Current version: ${version}`);
```

#### `setVersion(version, description)`
Records that a specific migration version has been applied.

```javascript
await db.setVersion(2, 'Added duplicate tracking columns');
```

#### `isMigrationApplied(version)`
Checks if a specific migration version has been applied.

```javascript
const applied = await db.isMigrationApplied(2);
if (applied) {
  console.log('Version 2 migration already applied');
}
```

### Schema Management

#### `initializeTables()`
Creates all database tables and sets the initial version to 1. Safe to call multiple times - will not recreate existing tables.

```javascript
await db.connect();
await db.initializeTables();
```

#### `updateSchema()`
Applies all pending migrations in order. Automatically detects current version and only applies necessary updates.

```javascript
await db.connect();
await db.updateSchema();
```

#### `getVersionHistory()`
Returns an array of all applied migrations with their details.

```javascript
const history = await db.getVersionHistory();
history.forEach(row => {
  console.log(`Version ${row.version}: ${row.description}`);
  console.log(`  Applied at: ${row.applied_at}`);
});
```

## Usage Examples

### Initial Setup (New Database)

```javascript
import { DatabaseManager } from './lib/database.js';

const db = new DatabaseManager({
  host: 'localhost',
  user: 'root',
  password: 'password',
  database: 'silverfilesystem'
});

// Connect and initialize
await db.connect();
await db.initializeTables();
// Database is now at version 1

// Check version
const version = await db.getCurrentVersion();
console.log(`Database version: ${version}`); // Output: 1
```

### Updating Existing Database

```javascript
import { DatabaseManager } from './lib/database.js';

const db = new DatabaseManager({
  host: 'localhost',
  user: 'root',
  password: 'password',
  database: 'silverfilesystem'
});

// Connect and update to latest schema
await db.connect();
await db.updateSchema();
// Applies version 2 and 3 migrations if needed

// Verify new version
const version = await db.getCurrentVersion();
console.log(`Database updated to version: ${version}`); // Output: 3
```

### Checking Migration Status

```javascript
// Check if specific migration is applied
const hasVersion2 = await db.isMigrationApplied(2);
const hasVersion3 = await db.isMigrationApplied(3);

console.log(`Version 2 applied: ${hasVersion2}`);
console.log(`Version 3 applied: ${hasVersion3}`);

// Get current version
const currentVersion = await db.getCurrentVersion();
console.log(`Current version: ${currentVersion}`);
```

## Adding New Migrations

To add a new migration (e.g., Version 4):

1. **Create Migration Method** in `lib/database.js`:

```javascript
/**
 * Migration: Version 4 - Add your feature description
 */
async migrateToVersion4() {
  if (!this.connection) {
    throw new Error('Database not connected. Call connect() first.');
  }

  console.log('Applying migration to version 4...');

  // Your schema changes here
  await this.connection.execute(`
    ALTER TABLE scanned_files
    ADD COLUMN your_new_column VARCHAR(255)
  `);
  console.log('Added your_new_column');

  await this.setVersion(4, 'Description of your changes');
  console.log('Migration to version 4 completed');
}
```

2. **Update updateSchema()** method to include the new migration:

```javascript
async updateSchema() {
  // ... existing code ...

  if (currentVersion < 4) {
    try {
      await this.migrateToVersion4();
    } catch (err) {
      // Handle errors appropriately
      if (err.message.includes('Duplicate column name') || err.message.includes('already exists')) {
        console.log('Version 4 changes already exist, marking as applied');
        await this.setVersion(4, 'Description of your changes');
      } else {
        throw err;
      }
    }
  }

  // ... existing code ...
}
```

3. **Test the migration**:
   - On a development database first
   - Verify it can be applied to existing databases
   - Ensure idempotency (can be run multiple times safely)

## Best Practices

### Migration Guidelines

1. **Always increment versions sequentially** - Don't skip version numbers
2. **Make migrations idempotent** - Safe to run multiple times
3. **Test on a copy of production data** before deploying
4. **Include descriptive migration descriptions** for audit trail
5. **Handle errors gracefully** - Don't leave database in inconsistent state
6. **Never modify existing migrations** - Create new ones instead
7. **Document breaking changes** clearly in migration description

### Error Handling

The migration system includes automatic error handling for common issues:

- **Column already exists**: Migration is marked as applied
- **Table already exists**: Skipped and marked as applied
- **Connection errors**: Exception thrown, no version recorded
- **Other SQL errors**: Exception thrown with full error details

### Rollback Strategy

Currently, migrations are forward-only. For rollback:

1. **Backup before migration**: Always backup database before updates
2. **Test migrations**: Test on development/staging first
3. **Manual rollback**: If needed, manually revert schema changes and version table entries

## Command Line Usage

### Using the CLI

```bash
# Initialize new database
node bin/cli.js scan /path --db
# (automatically runs initializeTables)

# Update existing database
node bin/cli.js scan /path --db
# (automatically runs updateSchema)
```

### Manual Migration

If you need to manually check or update the database:

```javascript
import { DatabaseManager } from './lib/database.js';

const db = new DatabaseManager();
await db.connect();

// Check current version
console.log('Version:', await db.getCurrentVersion());

// Apply updates
await db.updateSchema();

await db.close();
```

## Troubleshooting

### Version Mismatch

If version tracking gets out of sync with actual schema:

```sql
-- Check applied versions
SELECT * FROM db_version ORDER BY version;

-- Manually add missing version (use with caution)
INSERT INTO db_version (version, description) 
VALUES (2, 'Manually applied');
```

### Migration Failed Mid-way

If a migration fails partway through:

1. Check the error message
2. Manually complete the migration if possible
3. Mark version as applied with `setVersion()`
4. Or rollback changes and retry

### Version Table Doesn't Exist

If `db_version` table is missing but schema exists:

```javascript
await db.createVersionTable();
// Determine which version matches your schema
await db.setVersion(1, 'Existing schema baseline');
```

## Migration History

| Version | Date | Description |
|---------|------|-------------|
| 1 | 2025-11-04 | Initial schema with all base tables |
| 2 | 2025-11-04 | Updated extension column and added duplicate tracking |
| 3 | 2025-11-04 | Added folder_id column for normalized folder tracking |

## Future Enhancements

Planned improvements to the migration system:

- [ ] Rollback support for migrations
- [ ] Migration validation before applying
- [ ] Dry-run mode to preview changes
- [ ] Migration dependency checking
- [ ] Automatic backup before migrations
- [ ] Migration performance metrics
- [ ] Schema comparison tools
