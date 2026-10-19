# Stops every running Drivebay tray, launcher, and server for this user,
# including older copies in %LOCALAPPDATA%\Drivebay, so setup sees the saved
# port as free and never moves to another one. Touches no data or settings.
param([int]$WaitSeconds = 10)

$ErrorActionPreference = 'SilentlyContinue'
# Matches ...\Drivebay\launcher.mjs, ...\Drivebay\app\server\index.mjs and the
# same under any folder named Drivebay* (Programs\Drivebay, old copies).
$serverPattern = '(?i)\\drivebay[^\\"]*\\(launcher\.mjs|app\\server\\index\.mjs)'
$me = $PID
$stopped = @()

function Get-DrivebayProcesses {
  Get-CimInstance Win32_Process | Where-Object {
    $_.ProcessId -ne $me -and (
      ($_.Name -ieq 'DrivebayTray.exe') -or
      ($_.Name -ieq 'node.exe' -and $_.CommandLine -match $serverPattern)
    )
  }
}

# Trays first so they don't restart the server, then launchers, then servers.
$procs = @(Get-DrivebayProcesses)
$order = @($procs | Where-Object { $_.Name -ieq 'DrivebayTray.exe' }) +
         @($procs | Where-Object { $_.CommandLine -match '(?i)launcher\.mjs' }) +
         @($procs | Where-Object { $_.Name -ieq 'node.exe' -and $_.CommandLine -notmatch '(?i)launcher\.mjs' })
foreach ($p in $order) {
  & taskkill.exe /PID $p.ProcessId /T /F *> $null
  $stopped += "$($p.ProcessId) $($p.Name)"
}

$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Get-Date) -lt $deadline -and @(Get-DrivebayProcesses).Count -gt 0) { Start-Sleep -Milliseconds 250 }

if ($stopped.Count -gt 0) { Write-Output ("Stopped Drivebay processes: " + ($stopped -join ', ')) }
else { Write-Output "No running Drivebay processes." }
exit 0
