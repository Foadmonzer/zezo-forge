$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$DataPath = Join-Path (Join-Path $env:LOCALAPPDATA 'ZEZOForge') 'data-staging'
$Port = 4289
$EnvironmentKeys = @('ZEZO_STAGING','ZEZO_STAGING_ACCESS_PASSWORD','ZEZO_DATA_DIR','PORT','NODE_ENV','ZEZO_DISABLE_ADMIN_SETUP','RESEND_API_KEY','ZEZO_FROM_EMAIL','ZEZO_NOTIFICATION_EMAIL','OPENAI_API_KEY','OPENAI_MODEL','ZEZO_WHATSAPP_NUMBER','ZEZO_PUBLIC_URL')
$OriginalEnvironment = @{}
foreach ($key in $EnvironmentKeys) { $OriginalEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }

function Test-PortFree([int]$Number) {
  $probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Number)
  try { $probe.Start(); return $true }
  catch { return $false }
  finally { $probe.Stop() }
}

$Node = Get-Command node -ErrorAction SilentlyContinue
$Cloudflared = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $Node) { throw 'Node.js is required. Install Node.js 20 or newer, then run this script again.' }
if (-not $Cloudflared) {
  $wingetPackages = Join-Path $env:USERPROFILE 'AppData\Local\Microsoft\WinGet\Packages'
  $installedCloudflared = Get-ChildItem -LiteralPath $wingetPackages -Directory -Filter 'Cloudflare.cloudflared*' -ErrorAction SilentlyContinue | ForEach-Object { Join-Path $_.FullName 'cloudflared.exe' } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if ($installedCloudflared) { $Cloudflared = [pscustomobject]@{ Source = $installedCloudflared } }
}
if (-not $Cloudflared) { throw 'cloudflared is required for the temporary HTTPS link. Install it from https://developers.cloudflare.com/tunnel/downloads/ and run this script again.' }
if (-not (Test-PortFree $Port)) { throw "Port $Port is already in use. Stop that service or update the staging port in this script before continuing." }

if (Test-Path -LiteralPath $DataPath) {
  $existing = Get-Item -LiteralPath $DataPath -Force
  if (($existing.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing to use a linked staging-data folder.' }
}
New-Item -ItemType Directory -Path $DataPath -Force | Out-Null
$ResolvedDataPath = (Resolve-Path -LiteralPath $DataPath).Path
  if ([System.IO.Path]::GetFullPath($ResolvedDataPath).TrimEnd('\') -ne [System.IO.Path]::GetFullPath($DataPath).TrimEnd('\')) { throw 'Staging data path did not resolve to the expected isolated folder.' }

$randomBytes = New-Object byte[] 30
$randomSource = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $randomSource.GetBytes($randomBytes) } finally { $randomSource.Dispose() }
$AccessPassword = [Convert]::ToBase64String($randomBytes).TrimEnd('=').Replace('+','-').Replace('/','_')
$NodeProcess = $null
$ConfigPath = Join-Path $DataPath 'quick-tunnel-empty-config.yml'
Set-Content -LiteralPath $ConfigPath -Value "protocol: quic`n" -Encoding ascii

try {
  $env:ZEZO_STAGING = 'true'
  $env:ZEZO_STAGING_ACCESS_PASSWORD = $AccessPassword
  $env:ZEZO_DATA_DIR = $ResolvedDataPath
  $env:PORT = [string]$Port
  $env:NODE_ENV = 'production'
  $env:ZEZO_DISABLE_ADMIN_SETUP = ''
  foreach ($key in @('RESEND_API_KEY','ZEZO_FROM_EMAIL','ZEZO_NOTIFICATION_EMAIL','OPENAI_API_KEY','OPENAI_MODEL','ZEZO_WHATSAPP_NUMBER','ZEZO_PUBLIC_URL')) { Set-Item -Path "Env:$key" -Value '' }

  $logOut = Join-Path $DataPath 'server-output.log'
  $logErr = Join-Path $DataPath 'server-error.log'
  $NodeProcess = Start-Process -FilePath $Node.Source -ArgumentList 'server.js' -WorkingDirectory $Root -WindowStyle Hidden -PassThru -RedirectStandardOutput $logOut -RedirectStandardError $logErr
  Remove-Item Env:ZEZO_STAGING_ACCESS_PASSWORD -ErrorAction SilentlyContinue

  $ready = $false
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    if ($NodeProcess.HasExited) { throw "Staging server stopped during startup. Review $logErr" }
    if (Select-String -LiteralPath $logOut -Pattern 'ZEZO local preview:' -Quiet -ErrorAction SilentlyContinue) { $ready = $true; break }
    Start-Sleep -Milliseconds 250
  }
  if (-not $ready) { throw "Staging server did not become ready. Review $logErr" }

  Write-Host ''
  Write-Host 'ZEZO Forge isolated staging is ready.' -ForegroundColor Green
  Write-Host "Access password: $AccessPassword" -ForegroundColor Yellow
  Write-Host 'The staging site is protected by this generated password. Keep this window and the laptop online while you test. Press Ctrl+C to close the temporary link.'
  Write-Host ''
  & $Cloudflared.Source tunnel --config $ConfigPath --url "http://127.0.0.1:$Port"
}
finally {
  if ($NodeProcess -and -not $NodeProcess.HasExited) { Stop-Process -Id $NodeProcess.Id -Force -ErrorAction SilentlyContinue }
  foreach ($key in $EnvironmentKeys) {
    if ($null -eq $OriginalEnvironment[$key]) { Remove-Item -Path "Env:$key" -ErrorAction SilentlyContinue }
    else { Set-Item -Path "Env:$key" -Value $OriginalEnvironment[$key] }
  }
  $AccessPassword = $null
  [Array]::Clear($randomBytes, 0, $randomBytes.Length)
}
