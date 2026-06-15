@echo off
schtasks /create /tn "SilverFileSystem" /tr "cmd /c cd /d C:\AI_Server\Coding\SilverFileSystem && node server.js" /sc onlogon /rl highest /f
if %errorlevel% equ 0 (
    echo Task created successfully!
    schtasks /query /tn "SilverFileSystem"
) else (
    echo Failed to create task!
)
pause
