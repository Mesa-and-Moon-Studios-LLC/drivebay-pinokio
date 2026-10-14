# Writes the port, mode, and first-run account chosen in setup.
# The installer passes a UTF-16LE params file. Username and password are separate
# UTF-16LE files so they never appear on the command line.
# FileWrite (ANSI) must not be used for those files: this script reads UTF-16LE.
param(
  [Parameter(Mandatory = $true)]
  [string]$ParamsFile
)

$ErrorActionPreference = "Stop"
$resultFile = Join-Path $env:TEMP "drivebay-setup-result.txt"

function Write-Result([string]$text) {
  $one = ($text -replace "[\r\n]+", " ").Trim()
  if ($one.Length -gt 500) { $one = $one.Substring(0, 500) }
  # UTF-16LE without a BOM. NSIS FileReadUTF16LE would otherwise keep U+FEFF.
  $enc = New-Object System.Text.UnicodeEncoding $false, $false
  [System.IO.File]::WriteAllText($resultFile, $one + "`r`n", $enc)
  Write-Output $one
}

function Write-SetupLog([string]$dir, [string]$text) {
  if (-not $dir) { return }
  try {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $line = (Get-Date).ToString("s") + " " + $text
    Add-Content -LiteralPath (Join-Path $dir "setup.log") -Value $line -Encoding UTF8
  } catch {
  }
}

function Read-Utf16([string]$path) {
  $text = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::Unicode)
  return $text.TrimStart([char]0xFEFF).Trim([char]0)
}

$homeDir = $null
try {
  if (-not (Test-Path -LiteralPath $ParamsFile)) { throw "Setup params file was not found." }
  $raw = Read-Utf16 $ParamsFile
  $lines = @($raw -split "\r\n|\n|\r")
  if ($lines.Count -lt 6) { throw "Setup params file is incomplete." }
  $homeDir = $lines[0].Trim()
  $portText = $lines[1].Trim()
  $mode = $lines[2].Trim()
  $version = $lines[3].Trim()
  $userFile = $lines[4].Trim()
  $passFile = $lines[5].Trim()

  if (-not $homeDir) { throw "Drivebay data folder is empty." }
  if ($mode -ne "tailscale" -and $mode -ne "both" -and $mode -ne "regular") { throw "Mode must be tailscale, both, or regular." }
  $port = 0
  if (-not [int]::TryParse($portText, [ref]$port)) { throw "Port is not a number." }
  if ($port -lt 1024 -or $port -gt 65535) { throw "Port must be from 1024 to 65535." }

  New-Item -ItemType Directory -Force -Path (Join-Path $homeDir "data") | Out-Null
  $config = @{ port = $port; mode = $mode; version = $version } | ConvertTo-Json -Compress
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText((Join-Path $homeDir "config.json"), $config, $utf8)
  [System.IO.File]::WriteAllText((Join-Path $homeDir "drivebay.port"), "$port")
  if ($mode -eq "both") {
    [System.IO.File]::WriteAllText((Join-Path $homeDir "public-access.json"), '{"enabled":false,"offAt":null}', $utf8)
  }
  $pendingPath = Join-Path $homeDir "pending-account.json"
  if (Test-Path -LiteralPath $pendingPath) { Remove-Item -LiteralPath $pendingPath -Force }

  $userName = $null
  $password = $null
  try {
    if (-not (Test-Path -LiteralPath $userFile)) { throw "Username file was not found." }
    if (-not (Test-Path -LiteralPath $passFile)) { throw "Password file was not found." }
    $userName = (Read-Utf16 $userFile).Trim()
    # Keep password spaces. Only drop a UTF-16 BOM or a trailing NUL from FileWrite.
    $password = Read-Utf16 $passFile
  } finally {
    foreach ($secretFile in @($userFile, $passFile)) {
      try {
        if ($secretFile -and (Test-Path -LiteralPath $secretFile)) {
          $len = (Get-Item -LiteralPath $secretFile).Length
          [System.IO.File]::WriteAllBytes($secretFile, (New-Object byte[] $len))
          Remove-Item -LiteralPath $secretFile -Force
        }
      } catch {
      }
    }
  }

  if (-not $userName) { throw "Username is required." }
  if ($null -eq $password -or $password.Length -lt 8) { throw "Password must be at least 8 characters." }

  $pending = @{ username = $userName; password = $password } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($pendingPath, $pending, $utf8)
  if (-not (Test-Path -LiteralPath $pendingPath)) { throw "The account file was not created." }

  $saved = "Saved Drivebay account for port $port ($mode)."
  Write-SetupLog $homeDir $saved
  Write-Result "OK $saved"
  exit 0
} catch {
  $err = $_.Exception.Message
  if (-not $err) { $err = "$_" }
  Write-SetupLog $homeDir ("ERROR: " + $err)
  Write-Result ("ERROR: " + $err)
  exit 1
}
