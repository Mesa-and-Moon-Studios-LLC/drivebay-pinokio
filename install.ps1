# Drivebay command-line setup for Windows.
# No installer and no Pinokio. Run from PowerShell or CMD:
#   irm https://raw.githubusercontent.com/lordstryfe/drivebay-pinokio/main/install.ps1 | iex
#   powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/lordstryfe/drivebay-pinokio/main/install.ps1 | iex"
# Plain ASCII only. The account file is written by installer/windows/write-setup.ps1 as UTF-8.
# This file has no param() block so it still runs when piped to iex.

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$script:Repo = "lordstryfe/drivebay-pinokio"
# "main" installs the latest release server zip, or main when that zip is missing.
# This branch is not in the v3.20 release, and that release has no server zip, so the
# old script downloaded main. Main opens /login and then the file browser.
$script:SourceRef = "cursor/windows-script-install-d803"

function Test-NonInteractive {
  return ($env:DRIVEBAY_SETUP_ONLY -eq "1" -or $env:DRIVEBAY_NONINTERACTIVE -eq "1")
}

function Test-UsernameOk([string]$Name) {
  if ($null -eq $Name) { return $false }
  $value = $Name.Trim()
  if ($value.Length -lt 1 -or $value.Length -gt 64) { return $false }
  for ($i = 0; $i -lt $value.Length; $i++) {
    $c = $value[$i]
    $ok = $false
    if ($c -ge "0" -and $c -le "9") { $ok = $true }
    if ($c -ge "A" -and $c -le "Z") { $ok = $true }
    if ($c -ge "a" -and $c -le "z") { $ok = $true }
    if ($i -gt 0 -and ($c -eq "." -or $c -eq "-" -or $c -eq "_")) { $ok = $true }
    if (-not $ok) { return $false }
  }
  return $true
}

function Assert-Port([string]$Text) {
  $raw = ""
  if ($null -ne $Text) { $raw = $Text.Trim() }
  $port = 0
  if (-not [int]::TryParse($raw, [ref]$port)) { throw "Enter a port from 1024 to 65535." }
  if ($port -lt 1024 -or $port -gt 65535) { throw "Enter a port from 1024 to 65535." }
  return $port
}

function Test-PortFree([int]$Port) {
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

function Read-SecretLine([string]$Prompt) {
  $secure = Read-Host $Prompt -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringUni($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

function Read-Mode {
  $picked = $env:DRIVEBAY_SETUP_MODE
  if (-not [string]::IsNullOrWhiteSpace($picked)) {
    $picked = $picked.Trim().ToLower()
    if ($picked -ne "tailscale" -and $picked -ne "regular") { throw "Mode must be tailscale or regular." }
    return $picked
  }
  if (Test-NonInteractive) { throw "Mode must be tailscale or regular." }
  Write-Host "How should other devices reach this PC?"
  Write-Host "Both modes use a local port. Tailscale reaches it over your tailnet, with no router change."
  Write-Host "Regular mode needs that port forwarded on your router."
  Write-Host "  1) Tailscale - reach Drivebay over your tailnet"
  Write-Host "  2) Regular - this network, without Tailscale"
  while ($true) {
    $answer = Read-Host "Choice [2]"
    if ([string]::IsNullOrWhiteSpace($answer) -or $answer -eq "2" -or $answer.Trim().ToLower() -eq "regular") { return "regular" }
    if ($answer -eq "1" -or $answer.Trim().ToLower() -eq "tailscale") { return "tailscale" }
    Write-Host "Enter 1 or 2."
  }
}

function Read-ListenPort([string]$Mode) {
  $picked = $env:DRIVEBAY_SETUP_PORT
  if (-not [string]::IsNullOrWhiteSpace($picked)) {
    $port = Assert-Port $picked
    if (-not (Test-PortFree $port)) { throw "Port $port is already in use on this PC. Enter a different port." }
    return $port
  }
  if (Test-NonInteractive) { throw "Enter a port from 1024 to 65535." }
  Write-Host "Choose the port Drivebay listens on. This step is required."
  Write-Host "The port must be free on this PC (1024-65535)."
  if ($Mode -eq "tailscale") {
    Write-Host "Devices on your tailnet use this port. You do not open it on your router."
  } else {
    Write-Host "The next step tells you to forward this same port on your router."
  }
  while ($true) {
    $answer = Read-Host "Port [42013]"
    if ([string]::IsNullOrWhiteSpace($answer)) { $answer = "42013" }
    try {
      $port = Assert-Port $answer
    } catch {
      Write-Host $_.Exception.Message
      continue
    }
    if (-not (Test-PortFree $port)) {
      Write-Host "Port $port is already in use on this PC. Enter a different port."
      continue
    }
    return $port
  }
}

function Confirm-RouterForward([string]$Mode, [int]$Port) {
  if ($Mode -eq "tailscale") {
    Write-Host "Tailscale mode. Devices on your tailnet reach this PC at http://<this-PC-tailscale-name>:${Port}/ after you sign in to Tailscale on both devices."
    Write-Host "You do not open that port on your router."
    return
  }
  Write-Host "You have to open and forward TCP port $Port on your router."
  Write-Host "Phones and other computers cannot reach Drivebay until your router forwards port $Port to this PC."
  Write-Host "If Windows Firewall asks, allow Drivebay or TCP port $Port as well."
  $ack = $env:DRIVEBAY_SETUP_ACK
  if ([string]::IsNullOrWhiteSpace($ack)) {
    if (Test-NonInteractive) { throw "Type YES to confirm you will open and forward port $Port on your router." }
    $ack = Read-Host "Type YES to confirm you will open and forward port $Port on your router"
  }
  if ($ack.Trim() -ne "YES") { throw "Type YES to confirm you will open and forward port $Port on your router." }
}

function Read-YesNo([string]$EnvName, [string]$Prompt) {
  $picked = [Environment]::GetEnvironmentVariable($EnvName)
  if (-not [string]::IsNullOrWhiteSpace($picked)) {
    $picked = $picked.Trim().ToLower()
    return ($picked -eq "y" -or $picked -eq "yes" -or $picked -eq "1")
  }
  if (Test-NonInteractive) { return $false }
  $answer = Read-Host "$Prompt [y/N]"
  if ($null -eq $answer) { return $false }
  $answer = $answer.Trim().ToLower()
  return ($answer -eq "y" -or $answer -eq "yes")
}

function Read-Account {
  Write-Host "Set the only Drivebay account. After this, nobody else can sign up."
  Write-Host "Use at least 8 characters. This password is the lock for every drive on this PC."
  $userName = $env:DRIVEBAY_SETUP_USER
  if ([string]::IsNullOrWhiteSpace($userName)) {
    if (Test-NonInteractive) { throw "Username is required." }
    while ($true) {
      $userName = Read-Host "Username (letters, numbers, dot, dash, underscore)"
      if (Test-UsernameOk $userName) { break }
      Write-Host "Enter a username using letters, numbers, dots, dashes, or underscores."
    }
  } elseif (-not (Test-UsernameOk $userName)) {
    throw "Enter a username using letters, numbers, dots, dashes, or underscores."
  }
  $userName = $userName.Trim()

  $password = $env:DRIVEBAY_SETUP_PASSWORD
  if ($null -ne $password -and $password -ne "") {
    if ($password.Length -lt 8) { throw "Use a password of at least 8 characters." }
    return @{ User = $userName; Password = $password }
  }
  if (Test-NonInteractive) { throw "Use a password of at least 8 characters." }
  while ($true) {
    $first = Read-SecretLine "Password"
    $second = Read-SecretLine "Confirm password"
    if ($null -eq $first -or $first.Length -lt 8) {
      Write-Host "Use a password of at least 8 characters."
      continue
    }
    if ($first -ne $second) {
      Write-Host "Passwords do not match."
      continue
    }
    return @{ User = $userName; Password = $first }
  }
}

function Write-Utf16File([string]$Path, [string]$Text) {
  # Little-endian with BOM. write-setup.ps1 reads Encoding.Unicode (UTF-16LE).
  $enc = New-Object System.Text.UnicodeEncoding $false, $true
  [System.IO.File]::WriteAllText($Path, $Text, $enc)
}

function Read-DrivebayVersion([string]$Source) {
  $file = Join-Path $Source "VERSION.txt"
  if (Test-Path -LiteralPath $file) {
    $line = Get-Content -LiteralPath $file -TotalCount 1
    if ($line -match "(\d+\.\d+)") { return $Matches[1] }
  }
  return "3.21"
}

function Save-DrivebayAccount([string]$Root, [string]$SetupScript, [int]$Port, [string]$Mode, [string]$Version, [string]$UserName, [string]$Password) {
  if (-not (Test-Path -LiteralPath $SetupScript)) { throw "write-setup.ps1 was not found." }
  $temp = Join-Path ([System.IO.Path]::GetTempPath()) ("drivebay-setup-" + [guid]::NewGuid().ToString("n"))
  New-Item -ItemType Directory -Force -Path $temp | Out-Null
  $userFile = Join-Path $temp "user.txt"
  $passFile = Join-Path $temp "pass.txt"
  $params = Join-Path $temp "params.txt"
  $oldTemp = $env:TEMP
  $oldTmp = $env:TMP
  try {
    Write-Utf16File $userFile $UserName
    Write-Utf16File $passFile $Password
    $body = $Root + "`r`n" + $Port + "`r`n" + $Mode + "`r`n" + $Version + "`r`n" + $userFile + "`r`n" + $passFile + "`r`n"
    Write-Utf16File $params $body
    $env:TEMP = $temp
    $env:TMP = $temp
    $ps = $null
    $powershell = Get-Command powershell.exe -ErrorAction SilentlyContinue
    if ($powershell) { $ps = $powershell.Source }
    if (-not $ps) { $ps = (Get-Process -Id $PID).Path }
    & $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $SetupScript -ParamsFile $params
    $code = $LASTEXITCODE
    $resultFile = Join-Path $temp "drivebay-setup-result.txt"
    $result = ""
    if (Test-Path -LiteralPath $resultFile) {
      $result = [System.IO.File]::ReadAllText($resultFile, [System.Text.Encoding]::Unicode)
      $result = $result.TrimStart([char]0xFEFF).Trim()
    }
    if ($code -ne 0) {
      if (-not $result) { $result = "The account file could not be saved (exit $code)." }
      throw $result
    }
    $pending = Join-Path $Root "pending-account.json"
    if (-not (Test-Path -LiteralPath $pending)) { throw "The account file was not created." }
    if ($result) { Write-Host $result }
  } finally {
    if ($null -ne $oldTemp) { $env:TEMP = $oldTemp }
    if ($null -ne $oldTmp) { $env:TMP = $oldTmp }
    try { Remove-Item -LiteralPath $temp -Recurse -Force } catch {}
    $Password = $null
  }
}

function Write-UninstallScript([string]$Root) {
  $path = Join-Path $Root "uninstall.ps1"
  $text = @'
# Removes the Drivebay command-line install.
# The password database stays unless you type YES.
$ErrorActionPreference = "Continue"
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}

$Root = $PSScriptRoot
if (-not $Root) { $Root = Join-Path $env:LOCALAPPDATA "Drivebay" }

Write-Host "Stopping Drivebay."
$tray = Join-Path $Root "DrivebayTray.exe"
if (Test-Path -LiteralPath $tray) {
  try { & $tray --quit } catch {}
  Start-Sleep -Milliseconds 400
}
$node = Join-Path $Root "runtime\node.exe"
$launcher = Join-Path $Root "launcher.mjs"
if ((Test-Path -LiteralPath $node) -and (Test-Path -LiteralPath $launcher)) {
  try { & $node $launcher --stop } catch {}
}
$trayProc = @(Get-Process -Name "DrivebayTray" -ErrorAction SilentlyContinue)
if ($trayProc.Count -gt 0) {
  $oldNative = $null
  $hasNative = Test-Path variable:PSNativeCommandUseErrorActionPreference
  if ($hasNative) {
    $oldNative = $PSNativeCommandUseErrorActionPreference
    $PSNativeCommandUseErrorActionPreference = $false
  }
  $oldError = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { & taskkill.exe /IM DrivebayTray.exe /F 1>$null 2>$null } catch {}
  $ErrorActionPreference = $oldError
  if ($hasNative) { $PSNativeCommandUseErrorActionPreference = $oldNative }
}

$firewall = Join-Path $Root "windows\firewall.ps1"
if (Test-Path -LiteralPath $firewall) {
  $ps = $null
  $powershell = Get-Command powershell.exe -ErrorAction SilentlyContinue
  if ($powershell) { $ps = $powershell.Source } else { $ps = (Get-Process -Id $PID).Path }
  try { & $ps -NoProfile -ExecutionPolicy Bypass -File $firewall -Action remove } catch {}
}

$programs = Join-Path ([Environment]::GetFolderPath("Programs")) "Drivebay"
foreach ($name in @("Drivebay.lnk", "Uninstall Drivebay.lnk", "Stop Drivebay.lnk")) {
  $link = Join-Path $programs $name
  if (Test-Path -LiteralPath $link) { Remove-Item -LiteralPath $link -Force }
}
if (Test-Path -LiteralPath $programs) {
  $left = @(Get-ChildItem -LiteralPath $programs -Force -ErrorAction SilentlyContinue)
  if ($left.Count -eq 0) { Remove-Item -LiteralPath $programs -Force }
}
$desktop = Join-Path ([Environment]::GetFolderPath("Desktop")) "Drivebay.lnk"
if (Test-Path -LiteralPath $desktop) { Remove-Item -LiteralPath $desktop -Force }

try {
  $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
  $run = Get-ItemProperty -Path $runKey -Name Drivebay -ErrorAction SilentlyContinue
  if ($run -and $run.Drivebay -and ($run.Drivebay -like ("*" + $Root + "*"))) {
    Remove-ItemProperty -Path $runKey -Name Drivebay -ErrorAction SilentlyContinue
  }
} catch {}

Write-Host "Drivebay program files, shortcuts, and the startup entry will be removed."
Write-Host "The password database stays unless you type YES."
$answer = ""
try { $answer = Read-Host "Type YES to also delete the saved password and settings" } catch { $answer = "" }
$deleteData = ($answer -eq "YES")

$program = @(
  "app", "runtime", "windows", "assets",
  "launcher.mjs", "lib.mjs", "DrivebayTray.exe", "DrivebayTray.exe.config",
  "start-drivebay.vbs", "stop-drivebay.vbs", "VERSION.txt", "uninstall.ps1"
)
foreach ($name in $program) {
  $target = Join-Path $Root $name
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
}

if ($deleteData) {
  foreach ($name in @(
    "config.json", "drivebay.port", "pending-account.json", "auth.secret",
    "drivebay.log", "drivebay.pid", "setup.log", "data"
  )) {
    $target = Join-Path $Root $name
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
  }
  Write-Host "Removed Drivebay, including the saved password and settings."
} else {
  Write-Host "Removed Drivebay. The saved password and settings are still in $Root."
}
'@
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($path, $text.Replace("`n", "`r`n"), $utf8)
}

function New-StartShortcuts([string]$Root) {
  if ($env:OS -ne "Windows_NT") { return }
  $programs = Join-Path ([Environment]::GetFolderPath("Programs")) "Drivebay"
  New-Item -ItemType Directory -Force -Path $programs | Out-Null
  $shell = New-Object -ComObject WScript.Shell
  $icon = Join-Path $Root "assets\drivebay.ico"
  $start = $shell.CreateShortcut((Join-Path $programs "Drivebay.lnk"))
  $tray = Join-Path $Root "DrivebayTray.exe"
  $vbs = Join-Path $Root "start-drivebay.vbs"
  if (Test-Path -LiteralPath $tray) {
    $start.TargetPath = $tray
    $start.Arguments = ""
    $start.WorkingDirectory = $Root
  } else {
    $start.TargetPath = Join-Path $env:SystemRoot "System32\wscript.exe"
    $start.Arguments = "//B `"$vbs`""
    $start.WorkingDirectory = $Root
  }
  if (Test-Path -LiteralPath $icon) { $start.IconLocation = "$icon,0" }
  $start.Description = "Start Drivebay"
  $start.Save()

  $remove = $shell.CreateShortcut((Join-Path $programs "Uninstall Drivebay.lnk"))
  $ps = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  if (-not (Test-Path -LiteralPath $ps)) { $ps = "powershell.exe" }
  $remove.TargetPath = $ps
  $remove.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $Root "uninstall.ps1")`""
  $remove.WorkingDirectory = $Root
  $remove.Description = "Uninstall Drivebay"
  $remove.Save()
  Write-Host "Start menu shortcut: Drivebay"
}

function Invoke-Quiet([scriptblock]$Command) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  # Local assignment hides the session preference. A missing tray must not abort setup.
  if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
  }
  try {
    & $Command
  } catch {
  } finally {
    $ErrorActionPreference = $old
  }
}

function Stop-TrayImage {
  $procs = @(Get-Process -Name "DrivebayTray" -ErrorAction SilentlyContinue)
  if ($procs.Count -eq 0) { return }
  Invoke-Quiet { & taskkill.exe /IM DrivebayTray.exe /F 1>$null 2>$null }
}

function Start-InstalledDrivebay([string]$Root) {
  if ($env:DRIVEBAY_SKIP_START -eq "1") { return }
  $tray = Join-Path $Root "DrivebayTray.exe"
  if (Test-Path -LiteralPath $tray) {
    Start-Process -FilePath $tray -WorkingDirectory $Root | Out-Null
    return
  }
  Write-Host "The tray icon was not built. Starting Drivebay with the launcher."
  $vbs = Join-Path $Root "start-drivebay.vbs"
  if (Test-Path -LiteralPath $vbs) {
    Start-Process -FilePath "wscript.exe" -ArgumentList @("//B", $vbs) -WorkingDirectory $Root | Out-Null
    return
  }
  $node = Join-Path $Root "runtime\node.exe"
  $launcher = Join-Path $Root "launcher.mjs"
  if ((Test-Path -LiteralPath $node) -and (Test-Path -LiteralPath $launcher)) {
    Start-Process -FilePath $node -ArgumentList @($launcher) -WorkingDirectory $Root | Out-Null
  }
}

function Stop-InstalledDrivebay([string]$Root) {
  $tray = Join-Path $Root "DrivebayTray.exe"
  if (Test-Path -LiteralPath $tray) {
    Invoke-Quiet { & $tray --quit 1>$null 2>$null }
    Start-Sleep -Milliseconds 400
  }
  $node = Join-Path $Root "runtime\node.exe"
  $launcher = Join-Path $Root "launcher.mjs"
  if ((Test-Path -LiteralPath $node) -and (Test-Path -LiteralPath $launcher)) {
    Invoke-Quiet { & $node $launcher --stop 1>$null 2>$null }
  }
  Stop-TrayImage
}

function Get-WebHeaders {
  return @{ "User-Agent" = "DrivebayInstall"; "Accept" = "application/vnd.github+json" }
}

function Expand-ZipFile([string]$Zip, [string]$Dest) {
  New-Item -ItemType Directory -Force -Path $Dest | Out-Null
  $tar = Get-Command tar.exe -ErrorAction SilentlyContinue
  if ($tar) {
    & $tar.Source -xf $Zip -C $Dest
    if ($LASTEXITCODE -eq 0) { return }
  }
  Expand-Archive -LiteralPath $Zip -DestinationPath $Dest -Force
}

function Find-DrivebayRoot([string]$Dir) {
  if (Test-Path -LiteralPath (Join-Path $Dir "installer\launcher.mjs")) { return $Dir }
  if ((Test-Path -LiteralPath (Join-Path $Dir "launcher.mjs")) -and (Test-Path -LiteralPath (Join-Path $Dir "app\server\index.mjs"))) {
    return $Dir
  }
  $kids = @(Get-ChildItem -LiteralPath $Dir -Directory -ErrorAction SilentlyContinue)
  if ($kids.Count -eq 1) { return (Find-DrivebayRoot $kids[0].FullName) }
  throw "Downloaded Drivebay files were not recognized."
}

function Test-PrebuiltTree([string]$Source) {
  $server = Test-Path -LiteralPath (Join-Path $Source "app\server\index.mjs")
  $installer = Test-Path -LiteralPath (Join-Path $Source "installer\drivebay.nsi")
  return ($server -and -not $installer)
}

function Download-File([string]$Url, [string]$Dest) {
  Invoke-WebRequest -UseBasicParsing -Headers (Get-WebHeaders) -Uri $Url -OutFile $Dest
}

function Get-LatestRelease {
  try {
    return Invoke-RestMethod -Headers (Get-WebHeaders) -Uri "https://api.github.com/repos/$script:Repo/releases/latest"
  } catch {
    return $null
  }
}

function Get-ScriptCheckout {
  $self = $PSScriptRoot
  if ([string]::IsNullOrWhiteSpace($self)) { return $null }
  $launcher = Join-Path $self "installer\launcher.mjs"
  if (Test-Path -LiteralPath $launcher) { return $self }
  return $null
}

function Get-DrivebayTree {
  if (-not [string]::IsNullOrWhiteSpace($env:DRIVEBAY_SETUP_SOURCE)) {
    $given = $env:DRIVEBAY_SETUP_SOURCE
    if (-not (Test-Path -LiteralPath (Join-Path $given "installer\launcher.mjs"))) {
      throw "DRIVEBAY_SETUP_SOURCE is not a Drivebay checkout."
    }
    Write-Host "Using Drivebay files from $given"
    return $given
  }

  $checkout = Get-ScriptCheckout
  if ($checkout) {
    Write-Host "Using Drivebay files from $checkout"
    return $checkout
  }

  $ref = $env:DRIVEBAY_INSTALL_REF
  if ([string]::IsNullOrWhiteSpace($ref)) { $ref = $script:SourceRef }
  if ([string]::IsNullOrWhiteSpace($ref)) { $ref = "main" }

  $temp = Join-Path ([System.IO.Path]::GetTempPath()) ("drivebay-src-" + [guid]::NewGuid().ToString("n"))
  New-Item -ItemType Directory -Force -Path $temp | Out-Null
  $zip = Join-Path $temp "drivebay.zip"
  $extract = Join-Path $temp "extract"

  # A non-main ref must not fall through to the latest release or to main.
  # Those builds open the file browser on this PC.
  if ($ref -ne "main") {
    $url = "https://github.com/$script:Repo/archive/refs/heads/$ref.zip"
    Write-Host "Downloading Drivebay from $ref"
    Write-Host "The latest release is not used."
    try {
      Download-File $url $zip
    } catch {
      throw "Could not download Drivebay from $ref. $url"
    }
    Expand-ZipFile $zip $extract
    return (Find-DrivebayRoot $extract)
  }

  $release = Get-LatestRelease
  $asset = $null
  if ($release -and $release.assets) {
    $asset = @($release.assets) | Where-Object { $_.name -match "(?i)^drivebay-server.*\.zip$" } | Select-Object -First 1
  }
  if ($asset) {
    Write-Host "Downloading $($asset.name) from release $($release.tag_name)"
    Download-File $asset.browser_download_url $zip
  } else {
    if ($release) { Write-Host "Release $($release.tag_name) has no server archive. Downloading main." }
    else { Write-Host "No GitHub release found. Downloading main." }
    try {
      Download-File "https://github.com/$script:Repo/archive/refs/heads/main.zip" $zip
    } catch {
      if (-not $release) { throw "Could not download Drivebay from main." }
      Write-Host "Could not download main. Downloading release $($release.tag_name)."
      Download-File $release.zipball_url $zip
    }
  }
  Expand-ZipFile $zip $extract
  return (Find-DrivebayRoot $extract)
}

function Install-PortableNode([string]$RuntimeDir, [string]$Version) {
  $zipName = "node-v$Version-win-x64.zip"
  $url = "https://nodejs.org/dist/v$Version/$zipName"
  Write-Host "Downloading $url"
  $temp = Join-Path ([System.IO.Path]::GetTempPath()) ("drivebay-node-" + [guid]::NewGuid().ToString("n"))
  New-Item -ItemType Directory -Force -Path $temp | Out-Null
  try {
    $zip = Join-Path $temp $zipName
    Download-File $url $zip
    $sums = (Invoke-WebRequest -UseBasicParsing -Headers (Get-WebHeaders) -Uri "https://nodejs.org/dist/v$Version/SHASUMS256.txt").Content
    $match = $null
    foreach ($line in ($sums -split "`n")) {
      $trim = $line.Trim()
      if ($trim.EndsWith($zipName)) { $match = $trim; break }
    }
    if (-not $match) { throw "No checksum for $zipName" }
    $want = ($match -split "\s+")[0].ToLower()
    $got = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLower()
    if ($want -ne $got) { throw "Node zip checksum mismatch." }
    Write-Host "Node zip checksum ok"
    $extract = Join-Path $temp "extract"
    Expand-ZipFile $zip $extract
    $inner = Join-Path $extract "node-v$Version-win-x64"
    if (-not (Test-Path -LiteralPath (Join-Path $inner "node.exe"))) { throw "The Node download did not contain node.exe." }
    if (Test-Path -LiteralPath $RuntimeDir) { Remove-Item -LiteralPath $RuntimeDir -Recurse -Force }
    $parent = Split-Path -Parent $RuntimeDir
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    Move-Item -LiteralPath $inner -Destination $RuntimeDir
  } finally {
    try { Remove-Item -LiteralPath $temp -Recurse -Force } catch {}
  }
}

function Get-NodeMajor([string]$NodeExe) {
  $raw = & $NodeExe -p "process.versions.node"
  if ($LASTEXITCODE -ne 0 -or -not $raw) { return 0 }
  $major = 0
  [void][int]::TryParse(($raw.Trim().Split(".")[0]), [ref]$major)
  return $major
}

function Ensure-PortableNode([string]$RuntimeDir, [string]$VersionFile) {
  New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
  $node = Join-Path $RuntimeDir "node.exe"
  $version = "22.23.3"
  if ($VersionFile -and (Test-Path -LiteralPath $VersionFile)) {
    $fromFile = (Get-Content -LiteralPath $VersionFile -TotalCount 1).Trim()
    if ($fromFile) { $version = $fromFile }
  }
  if (Test-Path -LiteralPath $node) {
    $major = Get-NodeMajor $node
    if ($major -ge 22) {
      Write-Host "Using portable Node at $node"
      return $node
    }
  }
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $cmd) { $cmd = Get-Command node -ErrorAction SilentlyContinue }
  if ($cmd) {
    $major = Get-NodeMajor $cmd.Source
    if ($major -ge 22) {
      Write-Host "Node is already installed ($($cmd.Source)). Copying it for Drivebay."
      Copy-Item -LiteralPath $cmd.Source -Destination $node -Force
      $npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
      if (-not $npmCmd) { $npmCmd = Get-Command npm -ErrorAction SilentlyContinue }
      if (-not $npmCmd) { throw "npm was not found next to Node." }
      return $node
    }
    Write-Host "The installed Node is older than 22. Drivebay will download a portable Node."
  } else {
    Write-Host "Node was not found. Downloading a portable Node. No administrator account is required."
  }
  Install-PortableNode $RuntimeDir $version
  return (Join-Path $RuntimeDir "node.exe")
}

function Build-DrivebayServer([string]$Source, [string]$RuntimeDir) {
  $npm = Join-Path $RuntimeDir "npm.cmd"
  if (-not (Test-Path -LiteralPath $npm)) {
    $found = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $found) { $found = Get-Command npm -ErrorAction SilentlyContinue }
    if (-not $found) { throw "npm was not found. Drivebay needs Node.js 22." }
    $npm = $found.Source
  }
  $node = Join-Path $RuntimeDir "node.exe"
  $app = Join-Path $Source "app"
  Push-Location $app
  try {
    Write-Host "Installing Drivebay dependencies."
    & $npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm install failed ($LASTEXITCODE)." }
    Write-Host "Building the Drivebay server."
    $env:DRIVEBAY_STANDALONE = "1"
    & $npm run build
    if ($LASTEXITCODE -ne 0) { throw "The Drivebay server build failed ($LASTEXITCODE)." }
    & $node (Join-Path $Source "installer\copy-pglite-assets.mjs")
    if ($LASTEXITCODE -ne 0) { throw "Could not copy the database runtime files." }
  } finally {
    Pop-Location
  }
}

function Copy-ItemReplace([string]$From, [string]$To) {
  if (Test-Path -LiteralPath $To) { Remove-Item -LiteralPath $To -Recurse -Force }
  Copy-Item -LiteralPath $From -Destination $To -Recurse -Force
}

function Copy-ServerFiles([string]$Source, [string]$Root, [bool]$Prebuilt) {
  if ($Prebuilt) {
    foreach ($dir in @("app", "runtime", "windows", "assets")) {
      $from = Join-Path $Source $dir
      if (Test-Path -LiteralPath $from) { Copy-ItemReplace $from (Join-Path $Root $dir) }
    }
    foreach ($file in @("launcher.mjs", "lib.mjs", "start-drivebay.vbs", "stop-drivebay.vbs", "VERSION.txt", "DrivebayTray.exe")) {
      $from = Join-Path $Source $file
      if (Test-Path -LiteralPath $from) { Copy-Item -LiteralPath $from -Destination (Join-Path $Root $file) -Force }
    }
    return
  }
  $output = Join-Path $Source "app\.output"
  if (-not (Test-Path -LiteralPath (Join-Path $output "server\index.mjs"))) {
    throw "The Drivebay server build is missing."
  }
  Copy-ItemReplace $output (Join-Path $Root "app")
  $installer = Join-Path $Source "installer"
  foreach ($file in @("launcher.mjs", "lib.mjs", "start-drivebay.vbs", "stop-drivebay.vbs")) {
    Copy-Item -LiteralPath (Join-Path $installer $file) -Destination (Join-Path $Root $file) -Force
  }
  $ver = Join-Path $Source "VERSION.txt"
  if (Test-Path -LiteralPath $ver) { Copy-Item -LiteralPath $ver -Destination (Join-Path $Root "VERSION.txt") -Force }
  foreach ($dir in @("windows", "assets")) {
    Copy-ItemReplace (Join-Path $installer $dir) (Join-Path $Root $dir)
  }
}

function Compile-Tray([string]$Source, [string]$Root) {
  $cs = Join-Path $Source "installer\tray\DrivebayTray.cs"
  if (-not (Test-Path -LiteralPath $cs)) { $cs = Join-Path $Source "tray\DrivebayTray.cs" }
  if (-not (Test-Path -LiteralPath $cs)) {
    Write-Host "Tray source was not found. The start shortcut will use the launcher script."
    return
  }
  $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
  if (-not (Test-Path -LiteralPath $csc)) {
    $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe"
  }
  if (-not (Test-Path -LiteralPath $csc)) {
    Write-Host "The Windows C# compiler was not found. The start shortcut will use the launcher script."
    return
  }
  $icon = Join-Path $Root "assets\drivebay.ico"
  $out = Join-Path $Root "DrivebayTray.exe"
  Write-Host "Building the Drivebay tray icon."
  Invoke-Quiet {
    & $csc /nologo /target:winexe /optimize+ /platform:anycpu /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /win32icon:$icon /out:$out $cs
  }
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $out)) {
    if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue }
    Write-Host "The tray icon was not built. Drivebay will start with the launcher and open settings."
  }
}

function Invoke-Firewall([string]$Root) {
  $script = Join-Path $Root "windows\firewall.ps1"
  if (-not (Test-Path -LiteralPath $script)) { return }
  $ps = $null
  $powershell = Get-Command powershell.exe -ErrorAction SilentlyContinue
  if ($powershell) { $ps = $powershell.Source } else { $ps = (Get-Process -Id $PID).Path }
  & $ps -NoProfile -ExecutionPolicy Bypass -File $script -Action add
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Windows Firewall was not changed. Allow the Drivebay port if Windows asks."
  }
}

function Invoke-Tailscale([string]$Root, [bool]$Install, [bool]$Launch) {
  if ($Install) {
    $script = Join-Path $Root "windows\install-tailscale.ps1"
    Write-Host "Downloading the official Tailscale installer."
    $ps = $null
    $powershell = Get-Command powershell.exe -ErrorAction SilentlyContinue
    if ($powershell) { $ps = $powershell.Source } else { $ps = (Get-Process -Id $PID).Path }
    & $ps -NoProfile -ExecutionPolicy Bypass -File $script
    if ($LASTEXITCODE -ne 0) {
      Write-Host "Tailscale was not installed. Drivebay is still installed. Download Tailscale from https://tailscale.com/download/windows and sign in so this PC joins your tailnet."
    }
  }
  if ($Launch) {
    $script = Join-Path $Root "windows\launch-tailscale.ps1"
    if (Test-Path -LiteralPath $script) {
      $ps = $null
      $powershell = Get-Command powershell.exe -ErrorAction SilentlyContinue
      if ($powershell) { $ps = $powershell.Source } else { $ps = (Get-Process -Id $PID).Path }
      & $ps -NoProfile -ExecutionPolicy Bypass -File $script
    }
  }
}

function Start-DrivebayInstall {
  Write-Host "Drivebay setup"
  Write-Host "No installer and no Pinokio."

  $root = $env:DRIVEBAY_SETUP_HOME
  if ([string]::IsNullOrWhiteSpace($root)) {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { throw "LOCALAPPDATA is not set." }
    $root = Join-Path $env:LOCALAPPDATA "Drivebay"
  }
  New-Item -ItemType Directory -Force -Path $root | Out-Null

  $source = $null
  if ($env:DRIVEBAY_SETUP_ONLY -eq "1") {
    $source = $env:DRIVEBAY_SETUP_SOURCE
    if ([string]::IsNullOrWhiteSpace($source)) { throw "DRIVEBAY_SETUP_SOURCE is required for setup only." }
  } else {
    Stop-InstalledDrivebay $root
    $source = Get-DrivebayTree
    $prebuilt = Test-PrebuiltTree $source
    if (-not $prebuilt) {
      if ($env:DRIVEBAY_SKIP_NODE -ne "1") {
        Ensure-PortableNode (Join-Path $root "runtime") (Join-Path $source "installer\node-version.txt") | Out-Null
      }
      if ($env:DRIVEBAY_SKIP_BUILD -ne "1") {
        Build-DrivebayServer $source (Join-Path $root "runtime")
      }
    }
    Copy-ServerFiles $source $root $prebuilt
    if ($prebuilt -and -not (Test-Path -LiteralPath (Join-Path $root "runtime\node.exe"))) {
      $versionFile = Join-Path $source "node-version.txt"
      if (-not (Test-Path -LiteralPath $versionFile)) { $versionFile = Join-Path $source "installer\node-version.txt" }
      Ensure-PortableNode (Join-Path $root "runtime") $versionFile | Out-Null
    }
    $trayOut = Join-Path $root "DrivebayTray.exe"
    if (-not (Test-Path -LiteralPath $trayOut)) { Compile-Tray $source $root }
  }

  $mode = Read-Mode
  $port = Read-ListenPort $mode
  Confirm-RouterForward $mode $port
  $installTailscale = $false
  $launchTailscale = $false
  if ($mode -eq "tailscale") {
    $installTailscale = Read-YesNo "DRIVEBAY_INSTALL_TAILSCALE" "Download and install Tailscale (official installer)?"
    $launchTailscale = Read-YesNo "DRIVEBAY_LAUNCH_TAILSCALE" "Launch Tailscale when setup finishes?"
  }
  $account = Read-Account
  $setupScript = Join-Path $root "windows\write-setup.ps1"
  if (-not (Test-Path -LiteralPath $setupScript)) {
    $setupScript = Join-Path $source "installer\windows\write-setup.ps1"
  }
  Write-Host "Saving the Drivebay account."
  Save-DrivebayAccount $root $setupScript $port $mode (Read-DrivebayVersion $source) $account.User $account.Password
  $account.Password = $null

  Write-UninstallScript $root
  if ($env:DRIVEBAY_SETUP_ONLY -ne "1") {
    Invoke-Firewall $root
    if ($mode -eq "tailscale") { Invoke-Tailscale $root $installTailscale $launchTailscale }
    New-StartShortcuts $root
    Start-InstalledDrivebay $root
  }

  Write-Host ""
  Write-Host "Drivebay is installed."
  Write-Host "It does not open the file browser."
  Write-Host "The tray icon stays while Drivebay is running."
  if ($mode -eq "tailscale") {
    Write-Host "Other devices on your tailnet open http://<this-PC-tailscale-name>:${port}/ after Tailscale is signed in on both devices."
    Write-Host "You do not forward that port on your router."
  } else {
    Write-Host "You must open and forward TCP port $port on your router."
    Write-Host "Other devices use your public or LAN address on port $port."
  }
  Write-Host "Start shortcut: Drivebay, in the Start menu."
  Write-Host ("Uninstall script: " + (Join-Path $root "uninstall.ps1"))
  Write-Host "A reinstall does not replace an existing password."
  Write-Host "Drivebay is ready at http://127.0.0.1:${port}/settings"
}

if ($MyInvocation.InvocationName -ne ".") {
  try {
    Start-DrivebayInstall
  } catch {
    $message = $_.Exception.Message
    if (-not $message) { $message = "$_" }
    if ($message -notmatch "^ERROR:") { $message = "ERROR: " + $message }
    [Console]::Error.WriteLine($message)
    if ($PSCommandPath) { exit 1 }
  }
}
