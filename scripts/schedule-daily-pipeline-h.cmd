@echo off
REM SilverFS scheduled H:-only daily AI pipeline (03:00).
REM Submits to local /api/daily-pipeline (shows on /jobs); falls back to CLI if server down.
cd /d "%~dp0.."
node scripts\schedule-daily-pipeline-h.mjs %*
exit /b %ERRORLEVEL%
