# Package DriveBay debug APK with versionName in the filename.
# Layout:
#   dist\DriveBay-v{version}-debug.apk          (current)
#   dist\DriveBay-latest-debug.apk              (pointer)
#   dist\old\...                                (previous currents)
# Also mirrors versioned + latest into Downloads and X:\Android\projects\
#
# Usage:
#   pwsh -NoProfile -File X:\Android\projects\DriveBay\package-apk.ps1
#   pwsh -NoProfile -File ...\package-apk.ps1 -SkipBuild
param(
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppGradle = Join-Path $ProjectRoot "app\build.gradle.kts"
$OutApk = Join-Path $ProjectRoot "app\build\outputs\apk\debug\app-debug.apk"
$DistDir = Join-Path $ProjectRoot "dist"
$OldDir = Join-Path $DistDir "old"
$Downloads = Join-Path $env:USERPROFILE "Downloads"
$ProjectsRoot = Split-Path -Parent $ProjectRoot

if (-not (Test-Path $AppGradle)) { throw "Missing $AppGradle" }

$gradleText = Get-Content -Raw $AppGradle
if ($gradleText -notmatch 'versionName\s*=\s*"([^"]+)"') {
  throw "Could not parse versionName from app/build.gradle.kts"
}
$versionName = $Matches[1]
if ($gradleText -match 'versionCode\s*=\s*(\d+)') {
  $versionCode = $Matches[1]
} else {
  $versionCode = "?"
}

$safeVer = ($versionName -replace '[^\w\.\-]+', '-')
$versionedName = "DriveBay-v$safeVer-debug.apk"
$latestName = "DriveBay-latest-debug.apk"
$legacyName = "DriveBay-debug.apk"

function Move-ToOldIfExists([string]$path) {
  if (-not (Test-Path $path)) { return }
  $item = Get-Item $path
  # Don't archive the APK we're about to overwrite with the same versioned name
  if ($item.Name -eq $versionedName) { return }
  New-Item -ItemType Directory -Force -Path $OldDir | Out-Null
  $dest = Join-Path $OldDir $item.Name
  if (Test-Path $dest) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $dest = Join-Path $OldDir ("{0}.{1}" -f $item.BaseName, "$stamp$($item.Extension)")
  }
  Move-Item -Force $path $dest
}

if (-not $SkipBuild) {
  $env:JAVA_HOME = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { "C:\Program Files\Eclipse Adoptium\jdk-21.0.11.10-hotspot" }
  $env:ANDROID_HOME = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { "X:\Android\Sdk" }
  $gradle = "X:\Android\tools\gradle-8.9\bin\gradle.bat"
  Push-Location $ProjectRoot
  try {
    if (Test-Path $gradle) {
      & $gradle assembleDebug --no-daemon
    } else {
      & (Join-Path $ProjectRoot "gradlew.bat") assembleDebug --no-daemon
    }
    if ($LASTEXITCODE -ne 0) { throw "assembleDebug failed ($LASTEXITCODE)" }
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path $OutApk)) { throw "APK missing: $OutApk" }

New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
New-Item -ItemType Directory -Force -Path $OldDir | Out-Null
New-Item -ItemType Directory -Force -Path $Downloads | Out-Null

# Archive previous currents in dist\ (except same versioned filename)
Get-ChildItem -Path $DistDir -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like "DriveBay*.apk" -or $_.Name -eq "latest.txt" } |
  ForEach-Object { Move-ToOldIfExists $_.FullName }

$distVersioned = Join-Path $DistDir $versionedName
$distLatest = Join-Path $DistDir $latestName
Copy-Item -Force $OutApk $distVersioned
Copy-Item -Force $OutApk $distLatest

# latest.txt pointer
@"
versionName=$versionName
versionCode=$versionCode
file=$versionedName
built=$(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
"@ | Set-Content -Path (Join-Path $DistDir "latest.txt") -Encoding UTF8

# Mirror to Downloads + projects root (versioned + convenience latest/legacy)
$mirrors = @(
  (Join-Path $Downloads $versionedName),
  (Join-Path $ProjectsRoot $versionedName),
  (Join-Path $Downloads $latestName),
  (Join-Path $ProjectsRoot $latestName),
  (Join-Path $Downloads $legacyName),
  (Join-Path $ProjectsRoot $legacyName)
)
foreach ($t in $mirrors) {
  Copy-Item -Force $OutApk $t
}

Write-Output "versionName=$versionName versionCode=$versionCode"
Write-Output "dist=$distVersioned"
Write-Output "old=$OldDir"
Get-Item $distVersioned | Select-Object FullName, Length, LastWriteTime | Format-List
