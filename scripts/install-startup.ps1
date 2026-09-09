# Add OmniRoute Cookie Sync Bridge to Windows Startup
$startupFolder = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupFolder "OmniRoute-Cookie-Bridge.lnk"

$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($shortcutPath)
$Shortcut.TargetPath = "wscript.exe"
$Shortcut.Arguments = '"' + (Join-Path $PSScriptRoot 'start-silent.vbs') + '"'
$Shortcut.WorkingDirectory = Join-Path (Split-Path -Parent $PSScriptRoot) 'bridge'
$Shortcut.Description = "OmniRoute Chrome Cookie Sync Bridge"
$Shortcut.Save()

Write-Host "[SUCCESS] OmniRoute Cookie Sync Bridge registered in Windows Startup folder:" -ForegroundColor Green
Write-Host "          $shortcutPath"
