---
name: db-query
description: Run read-only SQL queries against the SilverFileSystem MySQL database using Node.js dotenv pattern
---

# Database Query Pattern

Query the MySQL database without writing temp scripts. Use inline `node -e` for simple queries.

## Connection Pattern

```javascript
import 'dotenv/config';
import { DatabaseManager } from './lib/database.js';
const db = new DatabaseManager();
await db.connect();
// ... queries ...
await db.close();
```

## Common Queries

**Check migration version:**
```sql
SELECT MAX(version) as v FROM db_version;
```

**Check table columns:**
```sql
SHOW COLUMNS FROM <table>;
```

**Face stats:**
```sql
SELECT face_group_id, match_source, COUNT(*) as c 
FROM detected_faces WHERE face_group_id IS NOT NULL 
GROUP BY face_group_id, match_source;
```

**Named groups:**
```sql
SELECT id, label, face_count, group_type, relationship, master_face_id, secondary_face_ids 
FROM face_groups WHERE label IS NOT NULL AND label != '';
```

## Important Notes

- PowerShell single-quote escaping breaks inline SQL. For complex queries, write a temp script to `scripts/_temp.js` and delete after.
- If migration columns are missing, run manually: `await db.migrateToVersion<N>();`
- Database is `silver_files_db` on `localhost:13306`.
- `face_descriptor` column is MEDIUMTEXT (stores JSON with optional 512-dim embedding array).
