# AGENTS.md

## Project overview
- Node.js/ESM file manager: scan drives, duplicates, media UIs, face/VLM tools.
- Entrypoints: [bin/cli.js](bin/cli.js) (CLI), [server.js](server.js) (Express 5 + MySQL - **not** Strapi).
- Core logic: [lib/](lib/); DB access: [lib/database.js](lib/database.js).
- **Config:** [lib/utils.js](lib/utils.js) `loadConfig()` loads `.env` (dotenv) then merges [config.json](config.json). **Environment variables always win.** Never invent DB settings from raw `config.json` alone.

## Database (critical for agents)
- Always connect the same way the app does: `loadConfig()` or Node/CLI with project `.env` loaded.
- On this machine, live UI data is **`DB_NAME` / `DB_PORT` from `.env`** (currently MySQL on **13306**, database **`silver_files_db`**).
- [config.json](config.json) may still point at a **different** host/port/database (e.g. `3306` / `silverfilesystem`). That is often **stale or empty**. Using it explains empty `folder_tree` / only a handful of files while `/tree` still looks full.
- Never read or paste `.env` / `config.json` passwords, JWT, or Google secrets. You may confirm non-secret keys only: `DB_HOST`, `DB_PORT`, `DB_NAME`, `PORT`.

## `/tree` and folder usage
- Page: `http://localhost:<PORT>/tree` (also via Cloudflare public host). Data from `folder_tree` (`recursive_size`, etc.).
- Usage treemap (read-only): `http://localhost:<PORT>/usage-chart` — uses `/api/folder-tree?foldersOnly=1&sort=recursive_size`. Not a cleanup tool; see `docs/USAGE_CHART_SPEC.md`.
- Refresh a path into DB:
  ```bash
  node bin/cli.js scan "C:\AI_Server" --db
  ```
  Successful `--db` scans **auto-call** `rebuildFolderTree()`.
- Rebuild only (no rescan):
  ```bash
  node bin/cli.js rebuild-folder-tree --db
  ```
- Disk-only scans (no `--db`) do **not** update `/tree`. Drive free space is separate (`/drive-usage` / OS tools), not `folder_tree`.

## Port and public URL
- Local listen: `process.env.PORT` (this PC often **4001**). Code fallback if unset: **14316** (not 3000; do not assume 4000).
- Public: `https://medialib2.tcghk.trade` - Cloudflare forward to this Express process.
- Google OAuth: keep `GOOGLE_CALLBACK_URL` / `FRONTEND_URL` on the public host unless the user asks for localhost-only OAuth.

## Working conventions
- Install dependencies with `npm install`.
- Run `npm test` for the automated test suite and `npm run server` / `start-server.bat` / `node server.js` to start the web server.
- Keep changes compatible with the existing Commander-based CLI pattern in [bin/cli.js](bin/cli.js).
- Prefer small, focused edits in the relevant module under [lib/](lib/) rather than introducing one-off logic in the entrypoints.
- Preserve existing async/await patterns, spinner/logging behavior, and CLI flag compatibility when editing scan or reporting flows.
- When changing database behavior, keep schema updates compatible with [lib/database.js](lib/database.js) and the guidance in [DATABASE.md](DATABASE.md) and [DATABASE_MIGRATIONS.md](DATABASE_MIGRATIONS.md).
- Media-related changes should also be checked against [lib/media.js](lib/media.js), [lib/photo-ui.js](lib/photo-ui.js), [lib/music-ui.js](lib/music-ui.js), and [lib/movie-ui.js](lib/movie-ui.js).
- Add or update tests under [test/](test/) when changing behavior, especially for scanning, duplicate detection, and database logic.
- Before changing code, tell the user what you will change.

## Documentation
- Start with [README.md](README.md), [SERVER_GUIDE.md](SERVER_GUIDE.md), [DATABASE.md](DATABASE.md), and [DATABASE_MIGRATIONS.md](DATABASE_MIGRATIONS.md) for implementation details.
- Link to these documents instead of copying large sections into new instructions.
- Treat sample host/port/database names in DATABASE.md as examples, not live settings.

## Cloudflare / public host
- Public host `https://medialib2.tcghk.trade` is Cloudflare-forwarded to the local Express server on this PC (`DESKTOP-MGIJD0I`).
- Prefer leaving `GOOGLE_CALLBACK_URL` and `FRONTEND_URL` on the public host. Local `http://localhost:<PORT>/login.html` then Google Sign-in ending on medialib2 is expected, not a bug.
- Do not "fix" OAuth by rewriting those env vars to localhost unless the user asks.
- Never dump secrets from `.env` or `config.json`.
