@echo off
REM SilverFS staged daily schedule. Args: --stage rescan|thumb|embed|classify
cd /d "%~dp0.."
node scripts\schedule-daily-drive.mjs %*
exit /b %ERRORLEVEL%
