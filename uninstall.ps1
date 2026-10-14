# Drivebay uninstall. Stops the server and tray, then removes the program.
# The saved account and settings stay unless you type YES or pass -Force.
# No param() block, so this still runs when piped to iex.
#
# PowerShell:
#   irm https://raw.githubusercontent.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/main/uninstall.ps1 | iex
# CMD:
#   powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/main/uninstall.ps1 | iex"
# Scripting, after the file is saved:
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1 -KeepData
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1 -Force
# With irm | iex, set DRIVEBAY_UNINSTALL_KEEP_DATA=1 or DRIVEBAY_UNINSTALL_FORCE=1.

$ErrorActionPreference = "Continue"
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$script:KeepData = $false
$script:ForceDelete = $false
foreach ($arg in @($args)) {
  $text = ""
  if ($null -ne $arg) { $text = [string]$arg }
  if ($text -match '^(?i)[-/]KeepData$') { $script:KeepData = $true }
  if ($text -match '^(?i)[-/]Force$') { $script:ForceDelete = $true }
}
if ($env:DRIVEBAY_UNINSTALL_KEEP_DATA -eq "1") { $script:KeepData = $true }
if ($env:DRIVEBAY_UNINSTALL_FORCE -eq "1") { $script:ForceDelete = $true }
if ($script:KeepData) { $script:ForceDelete = $false }

function Invoke-Quiet([scriptblock]$Command) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
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

function Invoke-QuietText([scriptblock]$Command) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
  }
  try {
    return @(& $Command 2>$null)
  } catch {
    return @()
  } finally {
    $ErrorActionPreference = $old
  }
}

function Test-SamePath([string]$Left, [string]$Right) {
  if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) { return $false }
  try {
    $a = [System.IO.Path]::GetFullPath($Left).TrimEnd('\', '/')
    $b = [System.IO.Path]::GetFullPath($Right).TrimEnd('\', '/')
  } catch {
    return $false
  }
  return $a.Equals($b, [StringComparison]::OrdinalIgnoreCase)
}

function Test-DrivebayLeaf([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
  try {
    $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
  } catch {
    return $false
  }
  $leaf = [System.IO.Path]::GetFileName($full)
  return ($leaf -eq "Drivebay")
}

function Get-DataRoot {
  if (-not [string]::IsNullOrWhiteSpace($env:DRIVEBAY_UNINSTALL_HOME)) { return $env:DRIVEBAY_UNINSTALL_HOME }
  if (-not [string]::IsNullOrWhiteSpace($env:DRIVEBAY_SETUP_HOME)) { return $env:DRIVEBAY_SETUP_HOME }
  if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { return (Join-Path $env:LOCALAPPDATA "Drivebay") }
  return ""
}

function Get-RegisteredInstallDir {
  if ($env:DRIVEBAY_UNINSTALL_SCOPE -eq "home") { return "" }
  try {
    $key = "HKCU:\Software\Drivebay"
    if (-not (Test-Path -LiteralPath $key)) { return "" }
    $props = Get-ItemProperty -LiteralPath $key -Name "InstallDir" -ErrorAction SilentlyContinue
    if ($props -and $props.InstallDir) { return [string]$props.InstallDir }
  } catch {
  }
  return ""
}

function Get-ProgramRoots([string]$DataRoot) {
  $list = New-Object System.Collections.Generic.List[string]
  if ($env:DRIVEBAY_UNINSTALL_SCOPE -eq "home") { return @($list) }
  $candidates = New-Object System.Collections.Generic.List[string]
  if (-not [string]::IsNullOrWhiteSpace($env:DRIVEBAY_UNINSTALL_PROGRAMS)) {
    $candidates.Add($env:DRIVEBAY_UNINSTALL_PROGRAMS)
  }
  if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    $programs = Join-Path $env:LOCALAPPDATA "Programs"
    $candidates.Add((Join-Path $programs "Drivebay"))
  }
  $registered = Get-RegisteredInstallDir
  if (-not [string]::IsNullOrWhiteSpace($registered)) { $candidates.Add($registered) }
  foreach ($candidate in $candidates) {
    if (-not (Test-DrivebayLeaf $candidate)) { continue }
    if (Test-SamePath $candidate $DataRoot) { continue }
    $full = [System.IO.Path]::GetFullPath($candidate)
    $seen = $false
    foreach ($existing in $list) {
      if (Test-SamePath $existing $full) { $seen = $true }
    }
    if (-not $seen) { $list.Add($full) }
  }
  return @($list)
}

function Add-UniquePort($List, [int]$Port) {
  if ($Port -lt 1 -or $Port -gt 65535) { return }
  foreach ($existing in @($List)) {
    if ([int]$existing -eq $Port) { return }
  }
  [void]$List.Add($Port)
}

function Get-DrivebayPorts([string[]]$Roots) {
  $ports = New-Object System.Collections.Generic.List[int]
  foreach ($root in @($Roots)) {
    if ([string]::IsNullOrWhiteSpace($root)) { continue }
    $portFile = Join-Path $root "drivebay.port"
    if (Test-Path -LiteralPath $portFile) {
      $text = ""
      try { $text = [System.IO.File]::ReadAllText($portFile).Trim() } catch { $text = "" }
      $parsed = 0
      if ([int]::TryParse($text, [ref]$parsed)) { Add-UniquePort $ports $parsed }
    }
    $config = Join-Path $root "config.json"
    if (Test-Path -LiteralPath $config) {
      $raw = ""
      try { $raw = [System.IO.File]::ReadAllText($config) } catch { $raw = "" }
      $match = [regex]::Match($raw, '"port"\s*:\s*(\d+)')
      if ($match.Success) { Add-UniquePort $ports ([int]$match.Groups[1].Value) }
    }
  }
  return @($ports)
}

function Test-DrivebayProcessName([string]$Name) {
  if ([string]::IsNullOrWhiteSpace($Name)) { return $false }
  return ($Name -match '^(?i)(node|DrivebayTray|wscript|cscript)$')
}

function Test-ProcessRunning([int]$ProcId) {
  if ($ProcId -le 0) { return $false }
  if ($env:OS -ne "Windows_NT" -and (Test-Path -LiteralPath "/proc")) {
    $status = Join-Path (Join-Path "/proc" ([string]$ProcId)) "status"
    if (-not (Test-Path -LiteralPath $status)) { return $false }
    try {
      $text = [System.IO.File]::ReadAllText($status)
      if ($text -match '(?m)^State:\s+Z') { return $false }
    } catch {
      return $false
    }
    return $true
  }
  $proc = $null
  try { $proc = Get-Process -Id $ProcId -ErrorAction SilentlyContinue } catch { return $false }
  if (-not $proc) { return $false }
  try { if ($proc.HasExited) { return $false } } catch {}
  return $true
}

function Stop-ProcessId([int]$ProcId) {
  if ($ProcId -le 0 -or $ProcId -eq $PID) { return }
  $proc = $null
  try { $proc = Get-Process -Id $ProcId -ErrorAction SilentlyContinue } catch { $proc = $null }
  if (-not $proc) { return }
  if (-not (Test-DrivebayProcessName ([string]$proc.ProcessName))) { return }
  Invoke-Quiet { Stop-Process -Id $ProcId -Force -ErrorAction SilentlyContinue }
  if (-not (Test-ProcessRunning $ProcId)) { return }
  if ($env:OS -eq "Windows_NT") {
    $taskkill = Get-Command taskkill.exe -ErrorAction SilentlyContinue
    if ($taskkill) {
      Invoke-Quiet { & $taskkill.Source /PID $ProcId /F 1>$null 2>$null }
    }
    return
  }
  $kill = Get-Command kill -ErrorAction SilentlyContinue
  if ($kill) {
    Invoke-Quiet { & $kill.Source -9 $ProcId 1>$null 2>$null }
  }
}

function Get-ListenerPids([int]$Port) {
  $ids = New-Object System.Collections.Generic.List[int]
  function Add-Listener([int]$Value) {
    if ($Value -gt 0 -and -not $ids.Contains($Value)) { [void]$ids.Add($Value) }
  }
  try {
    $conns = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    foreach ($conn in $conns) { Add-Listener ([int]$conn.OwningProcess) }
  } catch {
  }
  $lines = @()
  if ($env:OS -eq "Windows_NT") {
    $netstat = Get-Command netstat.exe -ErrorAction SilentlyContinue
    if ($netstat) { $lines = @(Invoke-QuietText { & $netstat.Source -ano }) }
  } else {
    $netstat = Get-Command netstat -ErrorAction SilentlyContinue
    if ($netstat) { $lines = @(Invoke-QuietText { & $netstat.Source -ltnp }) }
  }
  $pattern = ":" + $Port + "(\s|$)"
  foreach ($line in $lines) {
    $row = [string]$line
    if ($row -notmatch $pattern) { continue }
    if ($row -notmatch "LISTEN") { continue }
    $slash = [regex]::Match($row, "(\d+)/")
    if ($slash.Success) { Add-Listener ([int]$slash.Groups[1].Value) }
    $tail = [regex]::Match($row, "(\d+)\s*$")
    if ($tail.Success) { Add-Listener ([int]$tail.Groups[1].Value) }
  }
  return @($ids)
}

function Read-ProcessCommandLine([int]$ProcId) {
  if ($ProcId -le 0) { return "" }
  if ($env:OS -ne "Windows_NT") {
    $cmdPath = Join-Path (Join-Path "/proc" ([string]$ProcId)) "cmdline"
    if (Test-Path -LiteralPath $cmdPath) {
      try {
        $raw = [System.IO.File]::ReadAllText($cmdPath)
        return $raw.Replace([char]0, " ")
      } catch {
      }
    }
    return ""
  }
  try {
    $cim = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $ProcId) -ErrorAction SilentlyContinue
    if ($cim -and $cim.CommandLine) { return [string]$cim.CommandLine }
  } catch {
  }
  return ""
}

function Stop-CommandLineMatches([string[]]$Roots) {
  $needles = New-Object System.Collections.Generic.List[string]
  foreach ($root in @($Roots)) {
    if (-not [string]::IsNullOrWhiteSpace($root)) { $needles.Add($root) }
  }
  $needles.Add("start-drivebay.vbs")
  $needles.Add("stop-drivebay.vbs")
  $needles.Add("DrivebayTray.exe")
  $ids = New-Object System.Collections.Generic.List[int]
  try {
    $cim = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    foreach ($proc in $cim) {
      if ($proc.ProcessId) { [void]$ids.Add([int]$proc.ProcessId) }
    }
  } catch {
  }
  if (Test-Path -LiteralPath "/proc") {
    $dirs = @(Get-ChildItem -LiteralPath "/proc" -Directory -ErrorAction SilentlyContinue)
    foreach ($dir in $dirs) {
      if ($dir.Name -match '^\d+$') { [void]$ids.Add([int]$dir.Name) }
    }
  }
  foreach ($procId in @($ids)) {
    if ($procId -le 0 -or $procId -eq $PID) { continue }
    $cmd = Read-ProcessCommandLine $procId
    if ([string]::IsNullOrWhiteSpace($cmd)) { continue }
    $hit = $false
    foreach ($needle in $needles) {
      if ($cmd.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $hit = $true }
    }
    if ($hit) { Stop-ProcessId $procId }
  }
}

function Stop-DrivebayProcesses([string[]]$Roots, [int[]]$Ports) {
  foreach ($root in @($Roots)) {
    if ([string]::IsNullOrWhiteSpace($root)) { continue }
    $tray = Join-Path $root "DrivebayTray.exe"
    if (Test-Path -LiteralPath $tray) {
      Invoke-Quiet { & $tray --quit 1>$null 2>$null }
    }
    $node = Join-Path $root "runtime\node.exe"
    $launcher = Join-Path $root "launcher.mjs"
    if ((Test-Path -LiteralPath $node) -and (Test-Path -LiteralPath $launcher)) {
      Invoke-Quiet { & $node $launcher --stop 1>$null 2>$null }
    }
    $serverPidPath = Join-Path $root "drivebay.pid"
    if (Test-Path -LiteralPath $serverPidPath) {
      $text = ""
      try { $text = [System.IO.File]::ReadAllText($serverPidPath).Trim() } catch { $text = "" }
      $procId = 0
      if ([int]::TryParse($text, [ref]$procId)) { Stop-ProcessId $procId }
    }
  }
  $trayProc = @(Get-Process -Name "DrivebayTray" -ErrorAction SilentlyContinue)
  if ($trayProc.Count -gt 0) {
    $taskkill = Get-Command taskkill.exe -ErrorAction SilentlyContinue
    if ($taskkill) {
      Invoke-Quiet { & $taskkill.Source /IM DrivebayTray.exe /F 1>$null 2>$null }
    }
    foreach ($proc in $trayProc) { Stop-ProcessId ([int]$proc.Id) }
  }
  foreach ($port in @($Ports)) {
    foreach ($procId in @(Get-ListenerPids ([int]$port))) { Stop-ProcessId ([int]$procId) }
  }
  Stop-CommandLineMatches $Roots
  Start-Sleep -Milliseconds 300
}

function Remove-FirewallRule([string]$Root) {
  if ($env:OS -ne "Windows_NT") { return }
  if ([string]::IsNullOrWhiteSpace($Root)) { return }
  $script = Join-Path $Root "windows\firewall.ps1"
  if (-not (Test-Path -LiteralPath $script)) { return }
  $ps = $null
  $powershell = Get-Command powershell.exe -ErrorAction SilentlyContinue
  if ($powershell) { $ps = $powershell.Source }
  if (-not $ps) { return }
  Invoke-Quiet { & $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script -Action remove 1>$null 2>$null }
}

function Remove-NamedLinks([string]$Dir, [string[]]$Names, [bool]$AnyLink) {
  if ([string]::IsNullOrWhiteSpace($Dir)) { return }
  if (-not (Test-Path -LiteralPath $Dir)) { return }
  foreach ($name in @($Names)) {
    $path = Join-Path $Dir $name
    if (Test-Path -LiteralPath $path) {
      Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    }
  }
  if ($AnyLink) {
    $links = @(Get-ChildItem -LiteralPath $Dir -Filter "*.lnk" -Force -ErrorAction SilentlyContinue)
    foreach ($link in $links) {
      Remove-Item -LiteralPath $link.FullName -Force -ErrorAction SilentlyContinue
    }
    $left = @(Get-ChildItem -LiteralPath $Dir -Force -ErrorAction SilentlyContinue)
    if ($left.Count -eq 0) {
      Remove-Item -LiteralPath $Dir -Force -ErrorAction SilentlyContinue
    }
  }
}

function Get-OverrideOrFolder([string]$EnvName, [string]$Special) {
  $override = [Environment]::GetEnvironmentVariable($EnvName)
  if (-not [string]::IsNullOrWhiteSpace($override)) { return $override }
  if ($env:DRIVEBAY_UNINSTALL_SCOPE -eq "home") { return "" }
  try { return [Environment]::GetFolderPath($Special) } catch { return "" }
}

function Remove-DrivebayShortcuts {
  $startMenu = Get-OverrideOrFolder "DRIVEBAY_UNINSTALL_START_MENU" "Programs"
  if ($env:DRIVEBAY_UNINSTALL_START_MENU) {
    $menuDir = $env:DRIVEBAY_UNINSTALL_START_MENU
  } elseif (-not [string]::IsNullOrWhiteSpace($startMenu)) {
    $menuDir = Join-Path $startMenu "Drivebay"
  } else {
    $menuDir = ""
  }
  Remove-NamedLinks $menuDir @("Drivebay.lnk", "Stop Drivebay.lnk", "Uninstall Drivebay.lnk") $true

  $desktop = Get-OverrideOrFolder "DRIVEBAY_UNINSTALL_DESKTOP" "Desktop"
  Remove-NamedLinks $desktop @("Drivebay.lnk") $false

  $startup = Get-OverrideOrFolder "DRIVEBAY_UNINSTALL_STARTUP" "Startup"
  if (-not [string]::IsNullOrWhiteSpace($startup) -and (Test-Path -LiteralPath $startup)) {
    Remove-NamedLinks $startup @("Drivebay.lnk") $false
    $links = @(Get-ChildItem -LiteralPath $startup -Filter "Drivebay*.lnk" -Force -ErrorAction SilentlyContinue)
    foreach ($link in $links) {
      Remove-Item -LiteralPath $link.FullName -Force -ErrorAction SilentlyContinue
    }
  }
}

function Remove-DrivebayTasks {
  if ($env:DRIVEBAY_UNINSTALL_SCOPE -eq "home") { return }
  $schtasks = Get-Command schtasks.exe -ErrorAction SilentlyContinue
  if (-not $schtasks) { return }
  $names = New-Object System.Collections.Generic.List[string]
  foreach ($fixed in @("\Drivebay", "\DrivebayTray", "\Start Drivebay", "\Drivebay Server")) {
    $names.Add($fixed)
  }
  $lines = @(Invoke-QuietText { & $schtasks.Source /Query /FO LIST })
  foreach ($line in $lines) {
    $row = [string]$line
    $match = [regex]::Match($row, '(?i)TaskName:\s*(\S.*)$')
    if (-not $match.Success) { continue }
    $task = $match.Groups[1].Value.Trim()
    if ($task -match '(?i)Drivebay') { $names.Add($task) }
  }
  $done = @{}
  foreach ($name in $names) {
    if ($done.ContainsKey($name)) { continue }
    $done[$name] = $true
    Invoke-Quiet { & $schtasks.Source /Delete /TN $name /F 1>$null 2>$null }
  }
}

function Remove-DrivebayRegistration {
  if ($env:DRIVEBAY_UNINSTALL_SCOPE -eq "home") { return }
  try {
    $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
    if (Test-Path -LiteralPath $runKey) {
      Remove-ItemProperty -LiteralPath $runKey -Name "Drivebay" -ErrorAction SilentlyContinue
    }
  } catch {
  }
  try {
    $uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Drivebay"
    if (Test-Path -LiteralPath $uninstallKey) {
      Remove-Item -LiteralPath $uninstallKey -Recurse -Force -ErrorAction SilentlyContinue
    }
  } catch {
  }
  try {
    $appKey = "HKCU:\Software\Drivebay"
    if (Test-Path -LiteralPath $appKey) {
      Remove-Item -LiteralPath $appKey -Recurse -Force -ErrorAction SilentlyContinue
    }
  } catch {
  }
}

function Remove-Tree([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return }
  if (-not (Test-Path -LiteralPath $Path)) { return }
  try { Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue } catch {}
  if (Test-Path -LiteralPath $Path) {
    try { Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue } catch {}
  }
}

function Remove-ProgramFiles([string]$DataRoot, [bool]$DeleteData) {
  if ([string]::IsNullOrWhiteSpace($DataRoot)) { return }
  if (-not (Test-Path -LiteralPath $DataRoot)) { return }
  if ($DeleteData) {
    Remove-Tree $DataRoot
    return
  }
  $keep = @{
    "config.json" = $true
    "drivebay.port" = $true
    "pending-account.json" = $true
    "auth.secret" = $true
    "data" = $true
    "setup.log" = $true
    "drivebay.log" = $true
  }
  $children = @(Get-ChildItem -LiteralPath $DataRoot -Force -ErrorAction SilentlyContinue)
  foreach ($child in $children) {
    if (-not $keep.ContainsKey($child.Name)) { Remove-Tree $child.FullName }
  }
}

function Resolve-DeleteData([string]$DataRoot) {
  if ($script:KeepData) { return $false }
  if ($script:ForceDelete) { return $true }
  $interactive = $true
  if ($env:DRIVEBAY_NONINTERACTIVE -eq "1" -or $env:DRIVEBAY_SETUP_ONLY -eq "1") { $interactive = $false }
  if (-not $interactive) { return $false }
  Write-Host "Drivebay program files, shortcuts, and the startup entry will be removed."
  Write-Host "The password database stays unless you type YES."
  $answer = ""
  try { $answer = Read-Host "Type YES to also delete the saved password and settings" } catch { $answer = "" }
  if ($null -eq $answer) { $answer = "" }
  return ($answer.Trim() -eq "YES")
}

function Get-PinokioDrivebayNote {
  $hits = New-Object System.Collections.Generic.List[string]
  function Consider([string]$Name, [string]$Exe, [string]$Cmd, [int]$ProcId) {
    if ($ProcId -eq $PID) { return }
    $blob = ([string]$Name) + " " + ([string]$Exe) + " " + ([string]$Cmd)
    if ($blob -match '(?i)uninstall\.ps1' -or $blob -match '(?i)install\.ps1' -or $blob -match '(?i)--test') { return }
    $pinokio = $blob -match '(?i)pinokio'
    $caddy = $Name -match '(?i)^caddy(\.exe)?$'
    $drivebay = $blob -match '(?i)drivebay'
    if (-not $pinokio) { return }
    if (-not $caddy -and -not $drivebay) { return }
    $label = $Name
    if ([string]::IsNullOrWhiteSpace($label)) { $label = "pid " + $ProcId }
    if (-not [string]::IsNullOrWhiteSpace($Exe)) { $label = $label + " (" + $Exe + ")" }
    if (-not $hits.Contains($label)) { [void]$hits.Add($label) }
  }
  try {
    $cim = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    foreach ($proc in $cim) {
      $procId = 0
      if ($proc.ProcessId) { $procId = [int]$proc.ProcessId }
      Consider ([string]$proc.Name) ([string]$proc.ExecutablePath) ([string]$proc.CommandLine) $procId
    }
  } catch {
  }
  if ($hits.Count -eq 0 -and (Test-Path -LiteralPath "/proc")) {
    $dirs = @(Get-ChildItem -LiteralPath "/proc" -Directory -ErrorAction SilentlyContinue)
    foreach ($dir in $dirs) {
      if ($dir.Name -notmatch '^\d+$') { continue }
      $procId = [int]$dir.Name
      if ($procId -eq $PID) { continue }
      $name = ""
      $cmd = ""
      $comm = Join-Path $dir.FullName "comm"
      $cmdline = Join-Path $dir.FullName "cmdline"
      if (Test-Path -LiteralPath $comm) {
        try { $name = [System.IO.File]::ReadAllText($comm).Trim() } catch { $name = "" }
      }
      if (Test-Path -LiteralPath $cmdline) {
        try { $cmd = [System.IO.File]::ReadAllText($cmdline).Replace([char]0, " ") } catch { $cmd = "" }
      }
      Consider $name "" $cmd $procId
    }
  }
  if ($hits.Count -eq 0) { return "" }
  return "A Pinokio copy of Drivebay is still running: " + ($hits -join "; ") + ". This uninstall leaves Pinokio running. Stop Drivebay in Pinokio to free its port."
}

function Start-DrivebayUninstall {
  Write-Host "Stopping Drivebay."
  $dataRoot = Get-DataRoot
  $programRoots = @(Get-ProgramRoots $dataRoot)
  $roots = New-Object System.Collections.Generic.List[string]
  if (-not [string]::IsNullOrWhiteSpace($dataRoot)) { $roots.Add($dataRoot) }
  foreach ($programRoot in $programRoots) { $roots.Add($programRoot) }
  $ports = @(Get-DrivebayPorts @($roots))
  Stop-DrivebayProcesses @($roots) $ports
  Remove-FirewallRule $dataRoot
  foreach ($programRoot in $programRoots) { Remove-FirewallRule $programRoot }
  Remove-DrivebayShortcuts
  Remove-DrivebayTasks
  Remove-DrivebayRegistration
  $deleteData = Resolve-DeleteData $dataRoot
  Remove-ProgramFiles $dataRoot $deleteData
  foreach ($programRoot in $programRoots) { Remove-Tree $programRoot }
  if ($deleteData) {
    Write-Host "The saved account and settings were deleted."
  } elseif (-not [string]::IsNullOrWhiteSpace($dataRoot) -and (Test-Path -LiteralPath $dataRoot)) {
    Write-Host "The saved account and settings are still in $dataRoot."
  }
  $pinokio = Get-PinokioDrivebayNote
  if (-not [string]::IsNullOrWhiteSpace($pinokio)) { Write-Host $pinokio }
  Write-Host "Drivebay is uninstalled."
}

if ($MyInvocation.InvocationName -ne ".") {
  try {
    Start-DrivebayUninstall
  } catch {
    $message = $_.Exception.Message
    if (-not $message) { $message = "$_" }
    if ($message -notmatch "^ERROR:") { $message = "ERROR: " + $message }
    [Console]::Error.WriteLine($message)
    if ($PSCommandPath) { exit 1 }
  }
}
