@echo off
cd /d "%~dp0.."
node scripts\schedule-daily-drive.mjs --stage rescan %*
exit /b %ERRORLEVEL%
