@echo off
cd /d "%~dp0.."
node scripts\schedule-daily-drive.mjs --stage embed %*
exit /b %ERRORLEVEL%
