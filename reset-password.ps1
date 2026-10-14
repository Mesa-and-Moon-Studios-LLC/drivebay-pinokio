# Resets the Drivebay password on this PC only.
# The new password is typed here, masked, twice. It is not an argument,
# it is not printed, and it is not sent to another computer.
$ErrorActionPreference = "Stop"

foreach ($arg in $args) {
  $text = [string]$arg
  if ($text -match '^(?i)(-password|--password|/password)') {
    Write-Host "Type the new password when asked. Drivebay does not take it as an argument."
    exit 1
  }
  if ($text -ne "") {
    Write-Host "Type the new password when asked. Drivebay does not take it as an argument."
    exit 1
  }
}

if (-not [string]::IsNullOrWhiteSpace($env:DRIVEBAY_NEW_PASSWORD)) {
  Write-Host "Type the new password when asked. Drivebay does not take it from the environment."
  exit 1
}

function Find-DrivebayRoot {
  $candidates = @()
  if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) { $candidates += $PSScriptRoot }
  if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    $candidates += (Join-Path $env:LOCALAPPDATA "Drivebay")
    $candidates += (Join-Path $env:LOCALAPPDATA "Programs\Drivebay")
  }
  foreach ($dir in $candidates) {
    $node = Join-Path $dir "runtime\node.exe"
    $launcher = Join-Path $dir "launcher.mjs"
    if ((Test-Path -LiteralPath $node) -and (Test-Path -LiteralPath $launcher)) { return $dir }
  }
  return $null
}

function Convert-SecureText([Security.SecureString]$Secret) {
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secret)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

$root = Find-DrivebayRoot
if ([string]::IsNullOrWhiteSpace($root)) {
  Write-Host "Install or update Drivebay on this PC first. A password cannot be reset from another device."
  exit 1
}

$home = $env:DRIVEBAY_HOME
if ([string]::IsNullOrWhiteSpace($home)) {
  if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    Write-Host "Password reset only runs on this PC."
    exit 1
  }
  $home = Join-Path $env:LOCALAPPDATA "Drivebay"
}

$first = Read-Host -AsSecureString "New password"
$second = Read-Host -AsSecureString "Type it again"
$typed = $null
$again = $null
try {
  $typed = Convert-SecureText $first
  $again = Convert-SecureText $second
  if ($typed.Length -lt 8) {
    Write-Host "Use at least 8 characters."
    exit 1
  }
  if ($typed -cne $again) {
    Write-Host "Those passwords do not match."
    exit 1
  }

  $resultFile = Join-Path $home "reset-result.json"
  if (Test-Path -LiteralPath $resultFile) { Remove-Item -LiteralPath $resultFile -Force }

  $node = Join-Path $root "runtime\node.exe"
  $launcher = Join-Path $root "launcher.mjs"
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $node
  $psi.Arguments = "`"$launcher`" reset-password --stdin"
  $psi.WorkingDirectory = $root
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $false
  $psi.RedirectStandardError = $false
  $psi.EnvironmentVariables["DRIVEBAY_HOME"] = $home
  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  [void]$proc.Start()
  $proc.StandardInput.WriteLine($typed)
  $proc.StandardInput.Close()
  $typed = $null
  $again = $null
  if (-not $proc.WaitForExit(120000)) {
    try { $proc.Kill() } catch {}
    Write-Host "Password reset failed."
    exit 1
  }
  if (-not (Test-Path -LiteralPath $resultFile)) {
    if ($proc.ExitCode -eq 0) {
      Write-Host "Password updated. Sign in again on every device."
      exit 0
    }
    Write-Host "Password reset failed."
    exit 1
  }
  $raw = [System.IO.File]::ReadAllText($resultFile)
  Remove-Item -LiteralPath $resultFile -Force
  $parsed = $raw | ConvertFrom-Json
  if ($parsed.ok) {
    Write-Host ("Password updated for " + $parsed.username + ". Sign in again on every device. Settings, drives, and API tokens were kept.")
    exit 0
  }
  $reason = [string]$parsed.reason
  if ([string]::IsNullOrWhiteSpace($reason)) { $reason = "Password reset failed." }
  Write-Host $reason
  exit 1
} finally {
  $typed = $null
  $again = $null
}
