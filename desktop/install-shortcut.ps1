param([Parameter(Mandatory=$true)][string]$ApplicationRoot,[string]$DestinationDir)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if (-not $DestinationDir) { $DestinationDir = [Environment]::GetFolderPath('Desktop') }
if (-not (Test-Path -LiteralPath $DestinationDir)) { New-Item -ItemType Directory -Path $DestinationDir | Out-Null }
$target = Join-Path $ApplicationRoot 'Open Pi Loop Studio.cmd'
if (-not (Test-Path -LiteralPath $target)) { throw "Launcher missing: $target" }
$shell = New-Object -ComObject WScript.Shell
$shortcutPath = Join-Path $DestinationDir 'Pi Loop Studio.lnk'
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $target
$shortcut.WorkingDirectory = $ApplicationRoot
$shortcut.Description = 'Pi Agent Loop - local desktop workspace'
$shortcut.WindowStyle = 7
$shortcut.Save()
[Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut) | Out-Null
[Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null
Write-Output $shortcutPath

