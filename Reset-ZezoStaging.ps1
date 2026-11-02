$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$DataPath = Join-Path (Join-Path $env:LOCALAPPDATA 'ZEZOForge') 'data-staging'
$ExpectedPath = [System.IO.Path]::GetFullPath($DataPath).TrimEnd('\')
$ResolvedRoot = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'ZEZOForge')).TrimEnd('\')
$ParentPath = [System.IO.Path]::GetDirectoryName($ExpectedPath).TrimEnd('\')
if ($ParentPath -ne $ResolvedRoot -or [System.IO.Path]::GetFileName($ExpectedPath) -ne 'data-staging') { throw 'Refusing reset: the target path is not the fixed local staging folder.' }

$probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 4289)
try { $probe.Start() }
catch { throw 'Stop the ZEZO staging window before resetting data. The staging port is still in use.' }
finally { $probe.Stop() }

if (-not (Test-Path -LiteralPath $DataPath)) { Write-Host 'There is no staging data to reset.'; exit 0 }
$item = Get-Item -LiteralPath $DataPath -Force
if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing reset: the staging folder is a link or reparse point.' }
$resolved = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $DataPath).Path).TrimEnd('\')
if ($resolved -ne $ExpectedPath) { throw 'Refusing reset: the resolved folder differs from the fixed staging path.' }
$confirmation = Read-Host 'This permanently deletes only data-staging (test accounts, projects, chats, and uploads). Type RESET STAGING to continue'
if ($confirmation -cne 'RESET STAGING') { Write-Host 'Reset cancelled.'; exit 0 }
Remove-Item -LiteralPath $ExpectedPath -Recurse -Force
Write-Host 'Staging data removed. The original data and OneDrive staging folders were not changed.' -ForegroundColor Green
