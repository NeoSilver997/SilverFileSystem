$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\SilverFileSystem.lnk")
$Shortcut.TargetPath = "cmd.exe"
$Shortcut.Arguments = "/c cd /d C:\AI_Server\Coding\SilverFileSystem && node server.js"
$Shortcut.WorkingDirectory = "C:\AI_Server\Coding\SilverFileSystem"
$Shortcut.Description = "SilverFileSystem File Management Server"
$Shortcut.Save()

Write-Host "SilverFileSystem shortcut created in Startup folder!"
Write-Host "Location: $env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\SilverFileSystem.lnk"
