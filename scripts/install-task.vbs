Set objShell = CreateObject("Shell.Application")
Set objWMI = GetObject("winmgmts:\\.\root\cimv2")

objShell.ShellExecute "powershell.exe", "-Command ""schtasks /create /tn SilverFileSystem /xml C:\AI_Server\Coding\SilverFileSystem\scripts\SilverFileSystem.xml /f""", "", "runas", 1

WScript.Sleep 5000

objShell.ShellExecute "powershell.exe", "-Command ""schtasks /query /tn SilverFileSystem /fo LIST /v > C:\temp\taskverify.txt 2>&1""", "", "runas", 1
