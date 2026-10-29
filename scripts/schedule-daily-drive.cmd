@echo off
REM SilverFS daily drive schedule (03:00): H: every day + weekday rotate C/D/E/P/F.
REM Submits split thumb-hash / embed / classify batches to /jobs.
cd /d "%~dp0.."
node scripts\schedule-daily-drive.mjs %*
exit /b %ERRORLEVEL%
