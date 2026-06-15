Write-Host "Creating SilverFileSystem scheduled task..."
schtasks /create /tn "SilverFileSystem" /tr "cmd /c cd /d C:\AI_Server\Coding\SilverFileSystem && node server.js" /sc onlogon /rl highest /f

if ($LASTEXITCODE -eq 0) {
    Write-Host "`nVerifying task..." -ForegroundColor Yellow
    schtasks /query /tn "SilverFileSystem" /fo LIST /v
    Write-Host "`nSilverFileSystem will start automatically at login!" -ForegroundColor Green
} else {
    Write-Host "`nFailed to create task." -ForegroundColor Red
}
Read-Host "`nPress Enter to exit"
