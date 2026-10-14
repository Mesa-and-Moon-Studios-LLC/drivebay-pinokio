# Moves a saved Drivebay port out of 42000-42999.
# Pinokio's Caddy claims that range while Pinokio is running.
# -Suggest prints a free port, starting at 8765, and does not change files.
param(
  [switch]$Suggest,
  [string]$Root = ""
)

$ErrorActionPreference = "Stop"

function Test-ListenPortFree([int]$Port) {
  if ($Port -lt 1024 -or $Port -gt 65535) { return $false }
  if ($Port -ge 42000 -and $Port -le 42999) { return $false }
  $client = $null
  $open = $false
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $async = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    if ($async.AsyncWaitHandle.WaitOne(400, $false)) {
      try {
        $client.EndConnect($async)
        if ($client.Connected) { $open = $true }
      } catch {
        $open = $false
      }
    }
  } catch {
    $open = $false
  } finally {
    if ($null -ne $client) {
      try { $client.Close() } catch {}
    }
  }
  if ($open) { return $false }
  $listener = $null
  try {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Any, $Port)
    $listener.Start()
    return $true
  } catch {
    return $false
  } finally {
    if ($null -ne $listener) {
      try { $listener.Stop() } catch {}
    }
  }
}

function Find-DrivebayListenPort {
  foreach ($start in @(8765, 18080)) {
    for ($offset = 0; $offset -le 128; $offset++) {
      $candidate = $start + $offset
      if ($candidate -gt 65535) { break }
      if (Test-ListenPortFree $candidate) { return $candidate }
    }
  }
  return 8765
}

function Read-NumericPort([string]$Text) {
  $trim = ""
  if ($null -ne $Text) { $trim = $Text.Trim() }
  if ($trim.ToLowerInvariant() -eq "random") { return -1 }
  $parsed = 0
  if ([int]::TryParse($trim, [ref]$parsed) -and $parsed -ge 1024 -and $parsed -le 65535) { return $parsed }
  return 0
}

if ($Suggest) {
  Write-Output (Find-DrivebayListenPort)
  exit 0
}

if ([string]::IsNullOrWhiteSpace($Root)) {
  if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { exit 0 }
  $Root = Join-Path $env:LOCALAPPDATA "Drivebay"
}
$note = Join-Path ([System.IO.Path]::GetTempPath()) "drivebay-migrated-port.txt"
if (Test-Path -LiteralPath $note) { Remove-Item -LiteralPath $note -Force }

$portFile = Join-Path $Root "drivebay.port"
$filePort = 0
if (Test-Path -LiteralPath $portFile) {
  $fileText = ""
  try { $fileText = [System.IO.File]::ReadAllText($portFile) } catch { $fileText = "" }
  $filePort = Read-NumericPort $fileText
  if ($filePort -lt 0) { exit 0 }
}
$configPath = Join-Path $Root "config.json"
$configText = ""
$configPort = 0
if (Test-Path -LiteralPath $configPath) {
  try { $configText = [System.IO.File]::ReadAllText($configPath) } catch { $configText = "" }
  $match = [regex]::Match($configText, '"port"\s*:\s*"?(\d+)"?')
  if ($match.Success) { $configPort = Read-NumericPort $match.Groups[1].Value }
}
$saved = $filePort
if ($saved -lt 1024) { $saved = $configPort }
if ($saved -lt 42000 -or $saved -gt 42999) { exit 0 }

$chosen = Find-DrivebayListenPort
if ($chosen -ge 42000 -and $chosen -le 42999) { exit 0 }
$utf8 = New-Object System.Text.UTF8Encoding $false
if ($configText -match '"port"\s*:') {
  $updated = [regex]::Replace($configText, '"port"\s*:\s*"?\d+"?', ('"port":' + $chosen), 1)
  [System.IO.File]::WriteAllText($configPath, $updated, $utf8)
}
if ($filePort -ge 1024 -or -not (Test-Path -LiteralPath $portFile)) {
  [System.IO.File]::WriteAllText($portFile, ([string]$chosen), $utf8)
}
$netsh = Get-Command netsh.exe -ErrorAction SilentlyContinue
if ($netsh) {
  $oldPref = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
  }
  try { & $netsh.Source advfirewall firewall delete rule name=("Drivebay TCP " + $saved) | Out-Null } catch {}
  $ErrorActionPreference = $oldPref
}
[System.IO.File]::WriteAllText($note, ([string]$chosen), $utf8)
Write-Host ("The saved port " + $saved + " was in the range Pinokio's Caddy uses (42000-42999).")
Write-Host ("Drivebay moved to port " + $chosen + ".")
Write-Host ("The new address on this PC is http://127.0.0.1:" + $chosen + "/settings")
Write-Host "The firewall rule and the Start menu shortcut use that port."
exit 0
