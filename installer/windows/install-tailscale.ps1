# Downloads the official Tailscale Windows installer from pkgs.tailscale.com and runs it.
# -Quiet uses the official MSI and msiexec /quiet. The default runs the .exe installer.
param(
  [switch]$Quiet
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$page = Invoke-WebRequest -UseBasicParsing -Uri "https://pkgs.tailscale.com/stable/"
$found = [regex]::Matches($page.Content, "tailscale-setup-(\d+\.\d+\.\d+)\.exe")
if ($found.Count -lt 1) {
  throw "Could not find the official Tailscale Windows installer on pkgs.tailscale.com"
}
$ver = $found[0].Groups[1].Value
$quiet = $Quiet -or ($env:DRIVEBAY_TAILSCALE_QUIET -eq "1")
if ($quiet) {
  $arch = "amd64"
  $cpu = ""
  if ($env:PROCESSOR_ARCHITECTURE) { $cpu = $env:PROCESSOR_ARCHITECTURE.Trim().ToUpper() }
  if ($cpu -eq "ARM64") { $arch = "arm64" }
  elseif ($cpu -eq "X86") { $arch = "x86" }
  $url = "https://pkgs.tailscale.com/stable/tailscale-setup-$ver-$arch.msi"
  $dest = Join-Path $env:TEMP "tailscale-setup-$ver-$arch.msi"
} else {
  $url = "https://pkgs.tailscale.com/stable/tailscale-setup-$ver.exe"
  $dest = Join-Path $env:TEMP "tailscale-setup-$ver.exe"
}
Write-Output "Downloading $url"
Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $dest

try {
  $shaBody = (Invoke-WebRequest -UseBasicParsing -Uri "$url.sha256").Content.Trim()
  $sha = ($shaBody -split "\s+")[0].ToLower()
  $got = (Get-FileHash -Algorithm SHA256 -Path $dest).Hash.ToLower()
  if ($sha -and $got -ne $sha) {
    Remove-Item -Force $dest
    throw "Tailscale installer checksum did not match the official .sha256 file."
  }
  Write-Output "Tailscale installer checksum ok"
} catch {
  if ($_.Exception.Message -match "checksum") { throw }
  Write-Output "Continuing without a checksum file: $($_.Exception.Message)"
}

if ($quiet) {
  Write-Output "Starting the official Tailscale installer (quiet)"
  $msiexec = "msiexec.exe"
  if ($env:SystemRoot) {
    $candidate = Join-Path $env:SystemRoot "System32\msiexec.exe"
    if (Test-Path -LiteralPath $candidate) { $msiexec = $candidate }
  }
  # TS_NOLAUNCH stops the MSI from opening Tailscale. Setup opens it for sign-in.
  $proc = Start-Process -FilePath $msiexec -ArgumentList @("/i", $dest, "/quiet", "/norestart", "TS_NOLAUNCH=1") -Wait -PassThru
  if ($proc.ExitCode -eq 3010) { exit 0 }
  exit $proc.ExitCode
}

Write-Output "Starting the official Tailscale installer"
$proc = Start-Process -FilePath $dest -Wait -PassThru
exit $proc.ExitCode
