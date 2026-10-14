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
$script:SourceRef = "main"

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

function Test-TcpOpen([int]$Port) {
  $client = $null
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $async = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(500, $false)) { return $false }
    try { $client.EndConnect($async) } catch { return $false }
    return [bool]$client.Connected
  } catch {
    return $false
  } finally {
    if ($null -ne $client) {
      try { $client.Close() } catch {}
    }
  }
}

function Test-BindFree([int]$Port) {
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

function Get-ListenerProcessIds([int]$Port) {
  $ids = New-Object System.Collections.Generic.List[int]
  function Add-Id([int]$Value) {
    if ($Value -gt 0 -and $Value -ne $PID -and -not $ids.Contains($Value)) { [void]$ids.Add($Value) }
  }
  try {
    $conns = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    foreach ($conn in $conns) { Add-Id ([int]$conn.OwningProcess) }
  } catch {
  }
  $lines = @()
  $netstat = $null
  $netArgs = @()
  if ($env:OS -eq "Windows_NT") {
    $netstat = Get-Command netstat.exe -ErrorAction SilentlyContinue
    $netArgs = @("-ano", "-p", "tcp")
  } else {
    $netstat = Get-Command netstat -ErrorAction SilentlyContinue
    $netArgs = @("-ltnp")
  }
  if ($netstat) {
    $oldPref = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $hasNative = Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue
    $oldNative = $null
    if ($hasNative) {
      $oldNative = $PSNativeCommandUseErrorActionPreference
      $PSNativeCommandUseErrorActionPreference = $false
    }
    try { $lines = @(& $netstat.Source @netArgs 2>$null) } catch { $lines = @() }
    finally {
      $ErrorActionPreference = $oldPref
      if ($hasNative) { $PSNativeCommandUseErrorActionPreference = $oldNative }
    }
  }
  $pattern = ":" + $Port + "(\s|$)"
  foreach ($line in $lines) {
    $row = [string]$line
    if ($row -notmatch $pattern) { continue }
    if ($row -notmatch "LISTEN") { continue }
    $slash = [regex]::Match($row, "(\d+)/")
    if ($slash.Success) {
      Add-Id ([int]$slash.Groups[1].Value)
      continue
    }
    $tail = [regex]::Match($row, "(\d+)\s*$")
    if ($tail.Success) { Add-Id ([int]$tail.Groups[1].Value) }
  }
  return @($ids)
}

function Read-ProcessBlob([int]$ProcId) {
  $name = ""
  $exe = ""
  $cmd = ""
  try {
    $proc = Get-Process -Id $ProcId -ErrorAction SilentlyContinue
    if ($proc) {
      $name = [string]$proc.ProcessName
      try { if ($proc.Path) { $exe = [string]$proc.Path } } catch {}
    }
  } catch {
  }
  if ($env:OS -eq "Windows_NT") {
    try {
      $cim = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $ProcId) -ErrorAction SilentlyContinue
      if ($cim) {
        if ($cim.Name -and -not $name) { $name = [string]$cim.Name }
        if ($cim.ExecutablePath) { $exe = [string]$cim.ExecutablePath }
        if ($cim.CommandLine) { $cmd = [string]$cim.CommandLine }
      }
    } catch {
    }
  } else {
    $base = Join-Path "/proc" ([string]$ProcId)
    $comm = Join-Path $base "comm"
    $cmdline = Join-Path $base "cmdline"
    if (-not $name -and (Test-Path -LiteralPath $comm)) {
      try { $name = [System.IO.File]::ReadAllText($comm).Trim() } catch {}
    }
    if (Test-Path -LiteralPath $cmdline) {
      try { $cmd = [System.IO.File]::ReadAllText($cmdline).Replace([char]0, " ") } catch {}
    }
  }
  $label = $name
  if ([string]::IsNullOrWhiteSpace($label)) { $label = "pid " + $ProcId }
  if (-not [string]::IsNullOrWhiteSpace($exe)) { $label = $label + " (" + $exe + ")" }
  return @{ Label = $label; Blob = ($name + " " + $exe + " " + $cmd) }
}

function Test-OwnDrivebay([string]$Blob, [string]$Root) {
  if ([string]::IsNullOrWhiteSpace($Blob) -or [string]::IsNullOrWhiteSpace($Root)) { return $false }
  $full = $Root
  try { $full = [System.IO.Path]::GetFullPath($Root) } catch {}
  if ([string]::IsNullOrWhiteSpace($full)) { return $false }
  return ($Blob.IndexOf($full, [StringComparison]::OrdinalIgnoreCase) -ge 0)
}

function Get-PortConflict([int]$Port, [string]$IgnoreRoot) {
  $labels = New-Object System.Collections.Generic.List[string]
  $caddy = $false
  $pinokio = $false
  $ignoredOwn = $false
  foreach ($procId in @(Get-ListenerProcessIds $Port)) {
    if ($null -eq $procId) { continue }
    $parsedId = 0
    if (-not [int]::TryParse([string]$procId, [ref]$parsedId)) { continue }
    if ($parsedId -le 0) { continue }
    $info = Read-ProcessBlob $parsedId
    if (-not [string]::IsNullOrWhiteSpace($IgnoreRoot) -and (Test-OwnDrivebay ([string]$info.Blob) $IgnoreRoot)) {
      $ignoredOwn = $true
      continue
    }
    if (-not [string]::IsNullOrWhiteSpace($info.Label) -and -not $labels.Contains($info.Label)) {
      [void]$labels.Add($info.Label)
    }
    if ($info.Blob -match '(?i)caddy(\.exe)?') { $caddy = $true }
    elseif ($info.Blob -match '(?i)pinokio') { $pinokio = $true }
  }
  # An update keeps its port. Our own Drivebay still holding that port is not a conflict.
  if ($ignoredOwn -and $labels.Count -eq 0) { return "" }
  $busy = ($labels.Count -gt 0) -or (Test-TcpOpen $Port)
  if (-not $busy -and (Test-BindFree $Port)) { return "" }
  $text = "Port $Port is already in use"
  if ($labels.Count -gt 0) { $text = $text + " by " + ($labels -join "; ") }
  $text = $text + " on this PC."
  if ($caddy) {
    $text = $text + " That is Pinokio's Caddy (z:\pinokio\bin\miniforge\Library\bin\caddy.exe). It takes ports from 42000 to 42999 while Pinokio is running. Enter a different port outside that range, such as 8765."
  } elseif ($pinokio) {
    $text = $text + " That is a Pinokio copy of Drivebay."
  }
  return $text
}

function Test-DrivebayHealth([int]$Port) {
  $url = "http://127.0.0.1:" + $Port + "/api/health"
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 2
    $body = ""
    if ($null -ne $response.Content) { $body = [string]$response.Content }
    return ($body -match '"name"\s*:\s*"Drivebay"')
  } catch {
    return $false
  }
}

function Wait-DrivebayHealth([int]$Port, [int]$Seconds) {
  if ($Seconds -lt 1) { $Seconds = 30 }
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-DrivebayHealth $Port) { return $true }
    Start-Sleep -Milliseconds 400
  }
  return (Test-DrivebayHealth $Port)
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
    if ($picked -ne "tailscale" -and $picked -ne "both" -and $picked -ne "regular") { throw "Mode must be tailscale, both, or regular." }
    return $picked
  }
  if (Test-NonInteractive) { throw "Mode must be tailscale, both, or regular." }
  Write-Host "How should other devices reach this PC?"
  Write-Host "Tailscale is the safer choice. Nothing is opened to the internet. Only your own signed-in devices can reach Drivebay."
  Write-Host "Regular mode exposes the port publicly."
  Write-Host "Tailscale + Local (Both) keeps Tailscale, and adds a public path you can turn on later. That path starts off."
  Write-Host "  1) Tailscale (Recommended) - reach Drivebay over your tailnet"
  Write-Host "  2) Tailscale + Local (Both)"
  Write-Host "  3) No Tailscale (Regular mode)"
  while ($true) {
    $answer = Read-Host "Choice [1]"
    if ([string]::IsNullOrWhiteSpace($answer) -or $answer -eq "1" -or $answer.Trim().ToLower() -eq "tailscale") { return "tailscale" }
    if ($answer -eq "2" -or $answer.Trim().ToLower() -eq "both") { return "both" }
    if ($answer -eq "3" -or $answer.Trim().ToLower() -eq "regular") { return "regular" }
    Write-Host "Enter 1, 2, or 3."
  }
}

function Get-MigrateScript {
  $script = ""
  if (-not [string]::IsNullOrWhiteSpace($script:DrivebaySetupSource)) {
    $script = Join-Path $script:DrivebaySetupSource "installer\windows\migrate-listen-port.ps1"
  }
  if (-not [string]::IsNullOrWhiteSpace($script) -and (Test-Path -LiteralPath $script)) { return $script }
  if (-not [string]::IsNullOrWhiteSpace($script:DrivebaySetupRoot)) {
    $script = Join-Path $script:DrivebaySetupRoot "windows\migrate-listen-port.ps1"
  }
  if (-not [string]::IsNullOrWhiteSpace($script) -and (Test-Path -LiteralPath $script)) { return $script }
  return ""
}

function Get-DefaultListenPort {
  $migrate = Get-MigrateScript
  if ([string]::IsNullOrWhiteSpace($migrate)) { return 8765 }
  $text = & $migrate -Suggest
  $line = [string](@($text) | Select-Object -Last 1)
  $parsed = 0
  if ([int]::TryParse($line.Trim(), [ref]$parsed) -and $parsed -ge 1024 -and $parsed -le 65535) {
    if ($parsed -lt 42000 -or $parsed -gt 42999) { return $parsed }
  }
  return 8765
}

function Invoke-SavedPortMigration([string]$Root) {
  $migrate = Get-MigrateScript
  if ([string]::IsNullOrWhiteSpace($migrate)) { return 0 }
  $note = Join-Path ([System.IO.Path]::GetTempPath()) "drivebay-migrated-port.txt"
  if (Test-Path -LiteralPath $note) { Remove-Item -LiteralPath $note -Force }
  & $migrate -Root $Root
  if (-not (Test-Path -LiteralPath $note)) { return 0 }
  $raw = ""
  try { $raw = [System.IO.File]::ReadAllText($note).Trim() } catch { $raw = "" }
  Remove-Item -LiteralPath $note -Force -ErrorAction SilentlyContinue
  $parsed = 0
  if ([int]::TryParse($raw, [ref]$parsed) -and $parsed -ge 1024 -and $parsed -le 65535) { return $parsed }
  return 0
}

function Read-ListenPort([string]$Mode) {
  $picked = $env:DRIVEBAY_SETUP_PORT
  if (-not [string]::IsNullOrWhiteSpace($picked)) {
    $port = Assert-Port $picked
    $conflict = Get-PortConflict $port
    if (-not [string]::IsNullOrWhiteSpace($conflict)) { throw ($conflict + " Enter a different port.") }
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
  $suggested = Get-DefaultListenPort
  while ($true) {
    $answer = Read-Host ("Port [" + $suggested + "]")
    if ([string]::IsNullOrWhiteSpace($answer)) { $answer = [string]$suggested }
    try {
      $port = Assert-Port $answer
    } catch {
      Write-Host $_.Exception.Message
      continue
    }
    $conflict = Get-PortConflict $port
    if (-not [string]::IsNullOrWhiteSpace($conflict)) {
      Write-Host $conflict
      Write-Host "Enter a different port."
      continue
    }
    return $port
  }
}

function Get-LanIpv4 {
  $best = ""
  try {
    $nics = [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()
    foreach ($nic in $nics) {
      if ($nic.OperationalStatus -ne [System.Net.NetworkInformation.OperationalStatus]::Up) { continue }
      foreach ($addr in $nic.GetIPProperties().UnicastAddresses) {
        if ($addr.Address.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { continue }
        $ip = $addr.Address.ToString()
        if ($ip -eq "127.0.0.1" -or $ip.StartsWith("169.254.")) { continue }
        if ($ip.StartsWith("192.168.") -or $ip.StartsWith("10.") -or $ip -match "^172\.(1[6-9]|2[0-9]|3[0-1])\.") { return $ip }
        if (-not $best) { $best = $ip }
      }
    }
  } catch {
  }
  if ($best) { return $best }
  return ""
}

function Get-PublicIpv4 {
  foreach ($url in @("https://api.ipify.org", "https://ifconfig.me/ip")) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 3
      $text = ""
      if ($null -ne $response.Content) { $text = ([string]$response.Content).Trim() }
      if ($text -match "^\d{1,3}(\.\d{1,3}){3}$") { return $text }
    } catch {
    }
  }
  return ""
}

function Confirm-RouterForward([string]$Mode, [int]$Port) {
  if ($Mode -eq "tailscale") {
    Write-Host "Tailscale mode. Devices on your tailnet reach this PC at http://<this-PC-tailscale-name>:${Port}/ after you sign in to Tailscale on both devices."
    Write-Host "You do not open that port on your router."
    return
  }
  $localIp = Get-LanIpv4
  $publicIp = Get-PublicIpv4
  if ($Mode -eq "both") {
    Write-Host "Tailscale + Local (Both)."
    Write-Host "Public access starts off. Tailscale still reaches Drivebay."
  } else {
    Write-Host "No Tailscale (Regular mode)."
  }
  Write-Host "You have to open and forward TCP port $Port on your router."
  if ($localIp) {
    Write-Host "This PC's local IP is $localIp."
  } else {
    Write-Host "This PC's local IP could not be found. Run ipconfig and use the IPv4 address."
  }
  Write-Host "Log in to the router. The page is usually http://192.168.0.1 or http://192.168.1.1."
  Write-Host "Add a port forward for TCP $Port to that local IP."
  Write-Host "Give this PC a reserved or static IP in the router's DHCP settings so the address does not change."
  if ($publicIp) {
    Write-Host "This PC's public IP is $publicIp."
    Write-Host "From outside the network, open http://${publicIp}:${Port}/"
  } else {
    Write-Host "This PC's public IP could not be looked up. Search the web for what is my ip."
    Write-Host "From outside the network, open http://<public-ip>:${Port}/"
  }
  Write-Host "Some ISPs use CGNAT and block this. Tailscale is the easy fallback."
  Write-Host "Use a strong password. It is the lock for every drive on this PC."
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

function Test-EnvYes([string]$EnvName) {
  $picked = [Environment]::GetEnvironmentVariable($EnvName)
  if ([string]::IsNullOrWhiteSpace($picked)) { return $false }
  $picked = $picked.Trim().ToLower()
  return ($picked -eq "y" -or $picked -eq "yes" -or $picked -eq "1")
}

function Find-TailscaleExe {
  $candidates = New-Object System.Collections.Generic.List[string]
  if (-not [string]::IsNullOrWhiteSpace($env:DRIVEBAY_TAILSCALE_EXE)) {
    [void]$candidates.Add($env:DRIVEBAY_TAILSCALE_EXE.Trim())
  }
  if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
    [void]$candidates.Add((Join-Path $env:ProgramFiles "Tailscale\Tailscale.exe"))
  }
  $pf86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
  if (-not [string]::IsNullOrWhiteSpace($pf86)) {
    [void]$candidates.Add((Join-Path $pf86 "Tailscale\Tailscale.exe"))
  }
  foreach ($path in $candidates) {
    if ($path -and (Test-Path -LiteralPath $path)) { return $path }
  }
  return $null
}

function Test-TailscaleLoggedIn {
  $gui = Find-TailscaleExe
  if (-not $gui) { return $false }
  $cli = Join-Path (Split-Path -Parent $gui) "tailscale.exe"
  if (-not (Test-Path -LiteralPath $cli)) { return $false }
  $old = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $hasNative = Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue
  $oldNative = $null
  if ($hasNative) {
    $oldNative = $PSNativeCommandUseErrorActionPreference
    $PSNativeCommandUseErrorActionPreference = $false
  }
  $text = ""
  $code = 1
  try {
    $text = [string](& $cli status 2>&1 | Out-String)
    $code = $LASTEXITCODE
  } catch {
    $text = ""
    $code = 1
  } finally {
    $ErrorActionPreference = $old
    if ($hasNative) { $PSNativeCommandUseErrorActionPreference = $oldNative }
  }
  if ($code -ne 0) { return $false }
  if ($text -match '(?i)logged out') { return $false }
  if ($text -match '(?i)needs login') { return $false }
  if ($text -match '(?i)log in') { return $false }
  return ($text -match '\d+\.\d+\.\d+\.\d+')
}

function Read-TailscaleChoice {
  $picked = $env:DRIVEBAY_TAILSCALE
  if (-not [string]::IsNullOrWhiteSpace($picked)) {
    $picked = $picked.Trim().ToLower()
    if ($picked -eq "have" -or $picked -eq "yes" -or $picked -eq "y") { return "have" }
    if ($picked -eq "install") { return "install" }
    if ($picked -eq "skip" -or $picked -eq "no" -or $picked -eq "n") { return "skip" }
    throw "DRIVEBAY_TAILSCALE must be have, install, or skip."
  }
  if (Test-EnvYes "DRIVEBAY_INSTALL_TAILSCALE") { return "install" }
  $installed = Find-TailscaleExe
  if (Test-NonInteractive) {
    if ($installed) { return "have" }
    return "skip"
  }
  if ($installed) {
    Write-Host "Tailscale is already installed on this PC."
  } else {
    Write-Host "Tailscale was not found on this PC."
  }
  $default = "N"
  if ($installed) { $default = "Y" }
  $answer = Read-Host "Do you already have Tailscale? [$default]"
  $yes = $false
  if ([string]::IsNullOrWhiteSpace($answer)) {
    $yes = ($default -eq "Y")
  } else {
    $value = $answer.Trim().ToLower()
    $yes = ($value -eq "y" -or $value -eq "yes" -or $value -eq "1")
  }
  if ($yes) { return "have" }
  Write-Host "Drivebay can download and install Tailscale for Windows."
  Write-Host "The installer comes from the official Tailscale download."
  Write-Host "  1) Download and install Tailscale, then sign in"
  Write-Host "  2) Skip. You can install Tailscale and set it up later."
  while ($true) {
    $choice = Read-Host "Choice [1]"
    if ([string]::IsNullOrWhiteSpace($choice) -or $choice.Trim() -eq "1" -or $choice.Trim().ToLower() -eq "install") { return "install" }
    if ($choice.Trim() -eq "2" -or $choice.Trim().ToLower() -eq "skip") { return "skip" }
    Write-Host "Enter 1 or 2."
  }
}

function Resolve-WindowsScript([string]$Root, [string]$Source, [string]$Name) {
  $beside = Join-Path $Root (Join-Path "windows" $Name)
  if (Test-Path -LiteralPath $beside) { return $beside }
  if (-not [string]::IsNullOrWhiteSpace($Source)) {
    $fromSource = Join-Path $Source (Join-Path "installer" (Join-Path "windows" $Name))
    if (Test-Path -LiteralPath $fromSource) { return $fromSource }
  }
  return $null
}

function Install-OfficialTailscale([string]$Root, [string]$Source) {
  Write-Host "Downloading the official Tailscale installer."
  if ($env:DRIVEBAY_TAILSCALE_INSTALL_STUB -eq "1") {
    Write-Host "Tailscale installer finished."
    return $true
  }
  $script = Resolve-WindowsScript $Root $Source "install-tailscale.ps1"
  if (-not $script) {
    Write-Host "Tailscale was not installed. Download it from https://tailscale.com/download/windows and sign in later."
    return $false
  }
  $ps = Get-PowerShellExe
  $old = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $hasNative = Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue
  $oldNative = $null
  if ($hasNative) {
    $oldNative = $PSNativeCommandUseErrorActionPreference
    $PSNativeCommandUseErrorActionPreference = $false
  }
  $code = 1
  try {
    & $ps -NoProfile -ExecutionPolicy Bypass -File $script -Quiet
    $code = $LASTEXITCODE
  } catch {
    $code = 1
  } finally {
    $ErrorActionPreference = $old
    if ($hasNative) { $PSNativeCommandUseErrorActionPreference = $oldNative }
  }
  if ($code -ne 0) {
    Write-Host "Tailscale was not installed. Download it from https://tailscale.com/download/windows and sign in later."
    return $false
  }
  Write-Host "Tailscale installer finished."
  return $true
}

function Confirm-TailscaleSignIn {
  Write-Host "Sign in to Tailscale, or create a free Tailscale account."
  Write-Host "1. The Tailscale window is open."
  Write-Host "2. Click Sign in, or create a free account if you do not have one."
  Write-Host "3. Finish the sign-in in the browser."
  Write-Host "4. Come back here when this PC shows as connected."
  $gui = Find-TailscaleExe
  if ($gui -and $env:OS -eq "Windows_NT") {
    Invoke-Quiet { Start-Process -FilePath $gui | Out-Null }
  }
  if ($env:DRIVEBAY_TAILSCALE_SIGNED_IN -eq "1" -or (Test-TailscaleLoggedIn)) {
    Write-Host "Tailscale is signed in."
    return
  }
  if (Test-NonInteractive) {
    Write-Host "When Tailscale shows this PC as connected, other devices on your tailnet can reach Drivebay."
    return
  }
  while ($true) {
    if (Test-TailscaleLoggedIn) {
      Write-Host "Tailscale is signed in."
      return
    }
    $answer = Read-Host "Press Enter when Tailscale is signed in"
    if (Test-TailscaleLoggedIn) {
      Write-Host "Tailscale is signed in."
      return
    }
    if ($null -eq $answer -or $answer.Trim().ToLower() -ne "wait") {
      Write-Host "Continuing. Other devices can connect after this PC is signed in to Tailscale."
      return
    }
  }
}

function Read-ExistingInstall([string]$Root) {
  if ([string]::IsNullOrWhiteSpace($Root)) { return }
  if (-not (Test-Path -LiteralPath $Root)) { return }
  $port = 0
  $mode = ""
  $configPath = Join-Path $Root "config.json"
  if (Test-Path -LiteralPath $configPath) {
    $raw = ""
    try { $raw = [System.IO.File]::ReadAllText($configPath) } catch { $raw = "" }
    $portMatch = [regex]::Match($raw, '"port"\s*:\s*"?(\d+)"?')
    $modeMatch = [regex]::Match($raw, '"mode"\s*:\s*"(tailscale|both|regular)"')
    $parsed = 0
    if ($portMatch.Success -and $modeMatch.Success -and [int]::TryParse($portMatch.Groups[1].Value, [ref]$parsed)) {
      if ($parsed -ge 1024 -and $parsed -le 65535) {
        $port = $parsed
        $mode = $modeMatch.Groups[1].Value
      }
    }
  }
  if ($port -lt 1024) {
    $portFile = Join-Path $Root "drivebay.port"
    $pending = Join-Path $Root "pending-account.json"
    $data = Join-Path $Root "data"
    $secret = Join-Path $Root "auth.secret"
    $hasAccount = (Test-Path -LiteralPath $pending) -or (Test-Path -LiteralPath $data) -or (Test-Path -LiteralPath $secret)
    if ($hasAccount -and (Test-Path -LiteralPath $portFile)) {
      $text = ""
      try { $text = [System.IO.File]::ReadAllText($portFile).Trim() } catch { $text = "" }
      $parsed = 0
      if ([int]::TryParse($text, [ref]$parsed) -and $parsed -ge 1024 -and $parsed -le 65535) {
        $port = $parsed
        $mode = "regular"
      }
    }
  }
  if ($port -lt 1024 -or ($mode -ne "tailscale" -and $mode -ne "both" -and $mode -ne "regular")) { return }
  return ,@{ Port = $port; Mode = $mode }
}

function Update-DrivebayConfigVersion([string]$Root, [string]$Version) {
  $configPath = Join-Path $Root "config.json"
  if (-not (Test-Path -LiteralPath $configPath)) { return }
  $raw = ""
  try { $raw = [System.IO.File]::ReadAllText($configPath) } catch { return }
  $updated = $raw
  if ($raw -match '"version"\s*:\s*"') {
    $updated = [regex]::Replace($raw, '"version"\s*:\s*"[^"]*"', ('"version":"' + $Version + '"'), 1)
  } elseif ($raw -match '"version"\s*:') {
    $updated = [regex]::Replace($raw, '"version"\s*:\s*[^,}\r\n]+', ('"version":"' + $Version + '"'), 1)
  } else {
    $trimmed = $raw.TrimEnd()
    if (-not $trimmed.EndsWith("}")) { return }
    $body = $trimmed.Substring(0, $trimmed.Length - 1).TrimEnd()
    if ($body.EndsWith("{")) {
      $updated = $body + '"version":"' + $Version + '"}'
    } else {
      $updated = $body + ',"version":"' + $Version + '"}'
    }
  }
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($configPath, $updated, $utf8)
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
  return "3.31"
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

function Get-PowerShellExe {
  $powershell = Get-Command powershell.exe -ErrorAction SilentlyContinue
  if ($powershell) { return $powershell.Source }
  return (Get-Process -Id $PID).Path
}

function Resolve-UninstallScript {
  if ($PSScriptRoot) {
    $beside = Join-Path $PSScriptRoot "uninstall.ps1"
    if (Test-Path -LiteralPath $beside) { return $beside }
  }
  if ($script:UninstallSource -and (Test-Path -LiteralPath $script:UninstallSource)) {
    return $script:UninstallSource
  }
  $ref = $env:DRIVEBAY_INSTALL_REF
  if ([string]::IsNullOrWhiteSpace($ref)) { $ref = $script:SourceRef }
  if ([string]::IsNullOrWhiteSpace($ref)) { $ref = "main" }
  $temp = Join-Path ([System.IO.Path]::GetTempPath()) ("drivebay-uninstall-" + [guid]::NewGuid().ToString("n") + ".ps1")
  $url = "https://raw.githubusercontent.com/$script:Repo/$ref/uninstall.ps1"
  Download-File $url $temp
  $script:UninstallSource = $temp
  return $temp
}

function Invoke-ExistingUninstall([string]$Root) {
  $wipe = ($env:DRIVEBAY_UNINSTALL_FORCE -eq "1")
  $env:DRIVEBAY_UNINSTALL_HOME = $Root
  if (-not [string]::IsNullOrWhiteSpace($env:DRIVEBAY_SETUP_HOME)) {
    $env:DRIVEBAY_UNINSTALL_SCOPE = "home"
  }
  if ($wipe) {
    $env:DRIVEBAY_UNINSTALL_KEEP_DATA = "0"
    Write-Host "Removing any previous Drivebay install, including the saved account and settings."
  } else {
    $env:DRIVEBAY_UNINSTALL_KEEP_DATA = "1"
    $env:DRIVEBAY_UNINSTALL_FORCE = ""
    Write-Host "Removing any previous Drivebay install. The saved account and settings stay."
  }
  $scriptPath = Resolve-UninstallScript
  $ps = Get-PowerShellExe
  $old = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $hasNative = Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue
  $oldNative = $null
  if ($hasNative) {
    $oldNative = $PSNativeCommandUseErrorActionPreference
    $PSNativeCommandUseErrorActionPreference = $false
  }
  try {
    & $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $scriptPath
    $code = $LASTEXITCODE
  } catch {
    $code = 1
  } finally {
    $ErrorActionPreference = $old
    if ($hasNative) { $PSNativeCommandUseErrorActionPreference = $oldNative }
  }
  if ($code -ne 0) { throw "Drivebay could not be removed (exit $code)." }
}

function Copy-UninstallScript([string]$Root) {
  $source = Resolve-UninstallScript
  $dest = Join-Path $Root "uninstall.ps1"
  $same = $false
  try {
    if ((Test-Path -LiteralPath $source) -and (Test-Path -LiteralPath $dest)) {
      $left = [System.IO.Path]::GetFullPath($source)
      $right = [System.IO.Path]::GetFullPath($dest)
      $same = $left.Equals($right, [StringComparison]::OrdinalIgnoreCase)
    }
  } catch {
    $same = $false
  }
  if ($same) { return }
  Copy-Item -LiteralPath $source -Destination $dest -Force
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
  $existing = $null
  if ($env:DRIVEBAY_UNINSTALL_FORCE -ne "1") {
    $existing = Read-ExistingInstall $root
  }
  Invoke-ExistingUninstall $root
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

  $version = Read-DrivebayVersion $source
  $script:DrivebaySetupSource = $source
  $script:DrivebaySetupRoot = $root
  if ($null -ne $existing -and $existing.Port -ge 1024) {
    Update-DrivebayConfigVersion $root $version
    # A saved port in 42000-42999 belongs to Pinokio's Caddy. Move it before
    # the conflict check. Any other saved port stays.
    $movedPort = Invoke-SavedPortMigration $root
    if ($movedPort -ge 1024) { $existing.Port = $movedPort }
    # First-time setup is the only path that asks for a port. An update ignores
    # our own Drivebay if it still holds the saved port, and does not ask.
    $conflict = Get-PortConflict $existing.Port $root
    if (-not [string]::IsNullOrWhiteSpace($conflict)) {
      throw ($conflict + " The update keeps the saved port.")
    }
    Copy-UninstallScript $root
    $startedServer = $false
    if ($env:DRIVEBAY_SETUP_ONLY -ne "1") {
      Invoke-Firewall $root
      New-StartShortcuts $root
      if ($env:DRIVEBAY_SKIP_START -ne "1") {
        Start-InstalledDrivebay $root
        $startedServer = $true
      }
    }
    if ($startedServer) {
      Write-Host "Checking that this Drivebay server is answering on port $($existing.Port)."
      if (-not (Wait-DrivebayHealth $existing.Port 30)) {
        throw "Drivebay did not answer on port $($existing.Port). The program on that port is not this Drivebay server, so the update did not finish."
      }
    }
    Write-Host "Drivebay updated to $version"
    return
  }

  $mode = Read-Mode
  $tailscaleChoice = "skip"
  if ($mode -eq "tailscale" -or $mode -eq "both") {
    $tailscaleChoice = Read-TailscaleChoice
    if ($tailscaleChoice -eq "have") {
      Write-Host "Tailscale is already on this PC."
    } elseif ($tailscaleChoice -eq "install") {
      Install-OfficialTailscale $root $source | Out-Null
      Confirm-TailscaleSignIn
    } else {
      Write-Host "You can install Tailscale and set it up later."
      Write-Host "Setup will continue with the port, username, and password."
    }
  }
  $port = Read-ListenPort $mode
  Confirm-RouterForward $mode $port
  $account = Read-Account
  $setupScript = Join-Path $root "windows\write-setup.ps1"
  if (-not (Test-Path -LiteralPath $setupScript)) {
    $setupScript = Join-Path $source "installer\windows\write-setup.ps1"
  }
  Write-Host "Saving the Drivebay account."
  Save-DrivebayAccount $root $setupScript $port $mode $version $account.User $account.Password
  $account.Password = $null

  Copy-UninstallScript $root
  $startedServer = $false
  if ($env:DRIVEBAY_SETUP_ONLY -ne "1") {
    Invoke-Firewall $root
    if (($mode -eq "tailscale" -or $mode -eq "both") -and $tailscaleChoice -eq "have" -and (Test-EnvYes "DRIVEBAY_LAUNCH_TAILSCALE")) {
      Invoke-Tailscale $root $false $true
    }
    New-StartShortcuts $root
    if ($env:DRIVEBAY_SKIP_START -ne "1") {
      Start-InstalledDrivebay $root
      $startedServer = $true
    }
  }

  Write-Host ""
  Write-Host "Drivebay is installed."
  Write-Host "It does not open the file browser."
  Write-Host "The tray icon stays while Drivebay is running."
  if ($mode -eq "tailscale") {
    Write-Host "Other devices on your tailnet open http://<this-PC-tailscale-name>:${port}/ after Tailscale is signed in on both devices."
    Write-Host "You do not forward that port on your router."
  } elseif ($mode -eq "both") {
    Write-Host "Tailscale + Local (Both)."
    Write-Host "Other devices on your tailnet open http://<this-PC-tailscale-name>:${port}/ after Tailscale is signed in on both devices."
    Write-Host "Public access is off. The router path stays closed until you turn it on from this PC or from a signed-in Tailscale device."
    Write-Host "You must open and forward TCP port $port on your router before that public path can work."
  } else {
    Write-Host "You must open and forward TCP port $port on your router."
    Write-Host "Other devices use your public or LAN address on port $port."
  }
  Write-Host "Start shortcut: Drivebay, in the Start menu."
  Write-Host ("Uninstall script: " + (Join-Path $root "uninstall.ps1"))
  Write-Host "A reinstall does not replace an existing password."
  if ($startedServer) {
    Write-Host "Checking that this Drivebay server is answering on port $port."
    if (-not (Wait-DrivebayHealth $port 30)) {
      throw "Drivebay did not answer on port $port. The program on that port is not this Drivebay server, so setup did not finish. Choose a free port and run the install again."
    }
  }
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
