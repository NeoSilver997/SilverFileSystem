@echo off
REM SilverFS daily AI pipeline: thumbnail -> embed -> classify (latest 10000 images)
REM Usage: scripts\daily-ai-pipeline.cmd [--limit N] [--dry-run] [--path-prefix H:\] [--no-rescan] [--all-images]
cd /d "%~dp0.."
node scripts\daily-ai-pipeline.js %*
exit /b %ERRORLEVEL%
