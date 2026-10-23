# Keyword File Search Design (Phase 1 — MySQL FULLTEXT)

> SilverFileSystem feature design  
> Status: **Approved** (design section approved 2026-10-24)  
> Scope: Phase 1 keyword search only  
> Out of scope: DigUp-style content/embedding search (Phase 2)  
> Related inspiration (Phase 2 only): https://github.com/ARahim3/DigUp

---

## 1. Goal

Let authenticated users find files already stored in `scanned_files` by **keyword** against **file name and path**, with results showing **name, path, size, mtime**, and a click that opens the parent folder in `/tree`.

Deliverables for implementation (not this doc):

1. MySQL `FULLTEXT` index on `scanned_files(name, path)`.
2. Authenticated API `GET /api/files/search`.
3. Dedicated page `/search` (`public/search.html`).
4. Search bar on `/tree` that uses the same API.
5. Result row click → `/tree?path=<parent-folder>`.

---

## 2. Non-goals

- **Phase 2 content search** (file-body indexing, embeddings, vector DB, DigUp-style semantic search). DigUp is inspiration for Phase 2 only; do not add embedding pipelines, model downloads, or content extractors in Phase 1.
- Changing scan / rescan / Reload / Refresh-one-level behavior.
- Searching `folder_tree` folder names as a first-class result type (Phase 1 returns **files** only).
- Replacing or removing existing `/api/search-folder` (that endpoint lists files **inside one folder path**; it is not global keyword search). Keep it; do not overload it.
- Admin-only gating of search (same as `/tree`: any logged-in user).
- Boolean-mode query syntax UI, saved searches, or faceted filters (extension / size range) in Phase 1.

---

## 3. Background / Context

- File inventory lives in MySQL table `scanned_files` (`name VARCHAR(512)`, `path VARCHAR(2048)`, `size`, `mtime`, …), charset `utf8mb4`, engine InnoDB.
- `/tree` is the primary folder browser (`?path=` or `?id=`).
- `/api/search-folder` only resolves a folder then lists its files; it does **not** match keywords across the DB.
- Media/VLM search (`/api/vlm/search`) is photo-permission scoped and unrelated to filename keyword search.
- Schema changes follow versioned migrations in `lib/database.js` (`migrateToVersionN`, `updateSchema`, `isMigrationAlreadyAppliedError`, `setVersion`). Current latest migration in tree is **version 19**.

---

## 4. FULLTEXT mode choice

**Use `IN NATURAL LANGUAGE MODE`** (MySQL default for `MATCH … AGAINST`).

| Option | Decision |
|--------|----------|
| NATURAL LANGUAGE | **Chosen.** Simple UX: user types words; MySQL ranks by relevance. No operator training. |
| BOOLEAN MODE | Rejected for Phase 1. Powerful (`+`, `-`, `*`) but easy to misuse; can be a later optional `mode=` param. |

### Minimum token length

InnoDB FULLTEXT uses `innodb_ft_min_token_size` (MySQL default **3**). Tokens shorter than that are ignored by the index.

Phase 1 behavior:

- Trim `q`. If after trim length is **0**, return HTTP **400** `{ "error": "Query required" }`.
- If trimmed length is **1–2**, still run the query, but UI must show a note: short tokens may return no hits because of the server FULLTEXT min token size (typically 3). Do **not** silently fall back to `LIKE` in Phase 1 (keeps one code path; avoids full-table scans). Document that operators may lower `innodb_ft_min_token_size` and rebuild the FT index if 1–2 char CJK/Latin search becomes a product requirement later.
- Prefer multi-word / ≥3-character queries in smoke tests and UI placeholder text (e.g. `Search files by name or path…`).

Relevance: order results by `MATCH(name, path) AGAINST (? IN NATURAL LANGUAGE MODE)` descending, then `mtime DESC` as tie-breaker.

---

## 5. Schema / migration

### 5.1 Change

Add one InnoDB FULLTEXT index:

```sql
ALTER TABLE scanned_files
  ADD FULLTEXT INDEX ft_scanned_name_path (name, path);
```

Index name: **`ft_scanned_name_path`**.  
No new columns. No change to `CREATE TABLE scanned_files` baseline beyond documenting the index for fresh installs (optional: add the same FULLTEXT clause to the initial `CREATE TABLE IF NOT EXISTS` for new DBs so version 1 creates already include it; migration 20 remains required for existing DBs).

### 5.2 Versioned migration pattern (match project)

Follow existing `lib/database.js` style (see `migrateToVersion17` / `migrateToVersion19`):

1. Add **`async migrateToVersion20()`**:
   - Guard: throw if `!this.connection`.
   - Log `Applying migration to version 20...`.
   - `try/catch` around `ALTER TABLE scanned_files ADD FULLTEXT INDEX ft_scanned_name_path (name, path)`.
   - On error: if `this.isMigrationAlreadyAppliedError(err)` (covers `already exists` / duplicate key messaging), ignore; else rethrow.
   - `await this.setVersion(20, 'Added FULLTEXT index ft_scanned_name_path on scanned_files(name, path)')`.
2. In **`updateSchema()`**, after the `currentVersion < 19` block, add:

```js
if (currentVersion < 20) {
  try {
    await this.migrateToVersion20();
  } catch (err) {
    if (this.isMigrationAlreadyAppliedError(err)) {
      console.log('Version 20 changes already exist, marking as applied');
      await this.setVersion(20, 'Added FULLTEXT index ft_scanned_name_path on scanned_files(name, path)');
    } else {
      throw err;
    }
  }
}
```

3. Migration runs automatically on server/DB connect via existing `updateSchema()` — no separate CLI required for Phase 1.
4. Large tables: `ALTER TABLE … ADD FULLTEXT` may lock/copy; acceptable for this deploy. If production size becomes an issue later, document online DDL / maintenance window; not required for Phase 1 design.

### 5.3 Rollback (manual, not coded)

```sql
ALTER TABLE scanned_files DROP INDEX ft_scanned_name_path;
-- then adjust db_version if needed
```

No automated down-migration (project does not ship down migrations today).

---

## 6. API

### 6.1 Endpoint

```
GET /api/files/search?q=<keyword>&limit=50
```

- **Auth:** `requireAuthWrapper` (same as `/api/folder-tree`, `/tree` data APIs). Not `requireAdmin`.
- **Query params:**
  - `q` (required): search string. Trimmed server-side.
  - `limit` (optional): integer, default **50**, clamp to **1…100** (`Math.min(Math.max(parseInt(limit,10)||50, 1), 100)`).

### 6.2 Success response (200)

```json
{
  "q": "silverchan",
  "limit": 50,
  "count": 2,
  "results": [
    {
      "id": 12345,
      "name": "photo.jpg",
      "path": "C:\\Users\\HKC-USER\\Downloads\\silverchan\\photo.jpg",
      "size": 1048576,
      "mtime": "2026-10-18T15:22:01.000Z"
    }
  ]
}
```

Field rules:

| Field | Source | Notes |
|-------|--------|-------|
| `id` | `scanned_files.id` | For debugging / future deep links |
| `name` | `scanned_files.name` | Display name |
| `path` | Prefer non-null `scanned_files.path`; if null/empty, `CONCAT(folder_tree.folder_id, '\\', scanned_files.name)` via `LEFT JOIN folder_tree ON scanned_files.folder_id_int = folder_tree.id` | Always return a usable Windows-style path string when possible |
| `size` | `scanned_files.size` | Bytes (number) |
| `mtime` | `scanned_files.mtime` | ISO-8601 in JSON (mysql2 Date → JSON) |

Do **not** require `sizeFormatted` in the API; UI may format locally (same helper style as other pages).

### 6.3 SQL shape

```sql
SELECT
  sf.id,
  sf.name,
  COALESCE(NULLIF(sf.path, ''), CONCAT(ft.folder_id, '\\', sf.name)) AS path,
  sf.size,
  sf.mtime,
  MATCH(sf.name, sf.path) AGAINST (? IN NATURAL LANGUAGE MODE) AS score
FROM scanned_files sf
LEFT JOIN folder_tree ft ON sf.folder_id_int = ft.id
WHERE MATCH(sf.name, sf.path) AGAINST (? IN NATURAL LANGUAGE MODE)
ORDER BY score DESC, sf.mtime DESC
LIMIT ?
```

Bind `q` twice (SELECT score + WHERE), then `limit`. Use parameterized queries only.

### 6.4 Errors

| Case | HTTP | Body |
|------|------|------|
| Missing/blank `q` | 400 | `{ "error": "Query required" }` |
| Unauthenticated | same as other protected APIs (401/redirect behavior of `requireAuthWrapper`) | unchanged |
| DB / unexpected | 500 | `{ "error": "<message>" }` — do not leak credentials |

Empty match set is **200** with `count: 0` and `results: []` (not 404).

### 6.5 Naming note

Path is **`/api/files/search`**, not `/api/search-folder`. Keep `/api/search-folder` as the per-folder listing API.

---

## 7. UI

### 7.1 Dedicated `/search` page

- Route: `GET /search` in `server.js` → serve `public/search.html` (same pattern as `/tree`, `/usage-chart`).
- Page contents:
  - Auth gate consistent with other HTML apps (token / session check already used by dashboard/tree).
  - Search input + Submit / Enter.
  - Optional `limit` stays at default 50 (no need for a limit control in MVP).
  - Results table columns: **Name | Path | Size | Modified (mtime)**.
  - Empty state: “No files matched.”
  - Short-query hint when `q.trim().length > 0 && q.trim().length < 3`.
  - Loading and error states.
- **Click row:** navigate to  
  `/tree?path=` + `encodeURIComponent(parentDir)`  
  where `parentDir` is the directory portion of `result.path` (strip final `\name` / `/name`). If path has no separator, fall back to `/tree` without path.
- Dashboard: add an entry link next to Folder Tree / Usage Chart (“File Search” → `/search`).

### 7.2 Search bar on `/tree`

- Add a compact search control in the `/tree` header/toolbar (same visual family as existing buttons).
- On submit: either
  - **Preferred:** navigate to `/search?q=` + encoded query (single results UX), or
  - Inline dropdown of top N hits calling the same API, with “See all” → `/search?q=…`.
- Design choice for implementation: **navigate to `/search?q=`** for Phase 1 (simplest, one results UI). The bar still lives on `/tree` as requested.
- Do not break existing Refresh one level / Reload / Rebuild menu behavior.

### 7.3 Shared client

Both UIs call only `GET /api/files/search`. No duplicate query logic on the client beyond building the URL and rendering columns.

---

## 8. Auth

- HTML pages `/search` and `/tree` remain publicly servable as static shells (same as today); data APIs require auth.
- `GET /api/files/search` uses **`requireAuthWrapper`** only — aligned with folder-tree and tree mutation/read APIs.
- No new permission flag. No photo/music/video permission required (filename/path metadata is treated like folder tree visibility).

---

## 9. Edge cases

| Case | Behavior |
|------|----------|
| Empty / whitespace `q` | 400 `Query required` |
| `q` length 1–2 | Query runs; likely 0 hits; UI shows min-token note |
| No matches | 200, empty `results` |
| `limit` missing / NaN | Default 50 |
| `limit` > 100 | Clamp to 100 |
| `path` column null | COALESCE to `folder_tree.folder_id + '\' + name` |
| Both path and folder join missing | Return `name` only in `path` field; click goes to `/tree` |
| Special FULLTEXT chars / stopwords | NATURAL LANGUAGE stopwords may drop common English words; acceptable Phase 1 |
| Very large result space | Hard limit ≤100 rows |
| Concurrent migration | Idempotent via `isMigrationAlreadyAppliedError` + version row |
| CJK filenames | utf8mb4 table; NATURAL LANGUAGE tokenizes per MySQL ngram **only if** ngram parser is configured — **Phase 1 does not add ngram parser**. Document: default parser may be weak for pure CJK; Phase 1.1 can add `WITH PARSER ngram` if needed. Do not block Phase 1 ship on ngram. |

---

## 10. Testing smoke

Run after migration 20 is applied (server start / `updateSchema`):

1. **Index exists:**  
   `SHOW INDEX FROM scanned_files WHERE Key_name = 'ft_scanned_name_path';` → one FULLTEXT index on `name` and `path`.
2. **Auth:** unauthenticated `GET /api/files/search?q=test` → rejected like other APIs.
3. **Happy path:** authenticated search with a known filename token (≥3 chars) present in DB → `count >= 1`, each row has `name`, `path`, `size`, `mtime`.
4. **Empty:** `q=zzzxnotfound999` → 200, `count: 0`.
5. **Validation:** `q=` or omitted → 400.
6. **Limit clamp:** `limit=999` → at most 100 rows.
7. **UI `/search`:** submit query, see table, click row → lands on `/tree?path=` parent folder.
8. **UI `/tree` bar:** submit → opens `/search?q=…` with results.
9. **Regression:** `/api/search-folder` still lists files for a folder path; Refresh one level / Reload unchanged.

No automated test harness required for Phase 1 beyond this manual smoke (project’s existing pattern for UI features).

---

## 11. Phase 2 (explicitly out of scope)

Content / semantic search inspired by [DigUp](https://github.com/ARahim3/DigUp): embed file contents, store vectors, query by meaning. Separate design doc when scheduled. Phase 1 FULLTEXT keyword API and UI must remain usable alongside a future content endpoint (e.g. `/api/files/content-search`) without breaking clients.

---

## 12. Implementation checklist (for the coding pass — not done in this commit)

1. `migrateToVersion20` + `updateSchema` branch in `lib/database.js`.
2. `GET /api/files/search` in `server.js`.
3. `GET /search` + `public/search.html`.
4. Search bar on `public/tree.html` → `/search?q=`.
5. Dashboard link.
6. Smoke tests above.
7. Commit feature separately from this design doc.

---

## 13. Self-review

- Goals and non-goals are explicit; DigUp/content search is out of scope.
- API path, auth, response fields match the approved design (name, path, size, mtime; limit default 50).
- Migration follows existing versioned `migrateToVersionN` / `isMigrationAlreadyAppliedError` / `setVersion` pattern; next version is **20**.
- NATURAL LANGUAGE mode chosen; min token (≥3 typical) documented with UI note; no silent LIKE fallback.
- `/api/search-folder` left alone to avoid breaking per-folder listing.
- No unresolved placeholders; ngram/CJK called out as known limitation with a clear Phase 1.1 path, not an open question blocking implementation.
