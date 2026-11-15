#!/bin/bash
# Wrap drivebay-server-darwin-*.tar.gz into Drivebay-<version>-<arch>.dmg.
# The disk image holds Drivebay.app, an Applications shortcut, and a short readme.
# hdiutil is macOS-only. Elsewhere, or with DRIVEBAY_DMG_LAYOUT_ONLY=1, the
# layout is written under installer/dist/dmg-layout-<arch>/ for tests.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
INPUT="${1:-$ROOT/installer/dist}"
OUT="${DRIVEBAY_DMG_OUT:-$ROOT/installer/dist}"
LAYOUT_ONLY="${DRIVEBAY_DMG_LAYOUT_ONLY:-}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  LAYOUT_ONLY=1
fi

version_line="$(head -n 1 "$ROOT/VERSION.txt")"
VERSION="$(printf '%s\n' "$version_line" | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -n 1 || true)"
if [[ -z "$VERSION" ]]; then
  printf '%s\n' "VERSION.txt has no version." >&2
  exit 1
fi

find_tar() {
  find "$INPUT" -type f -name "drivebay-server-darwin-$1.tar.gz" | head -n 1
}

ARM_TAR="$(find_tar arm64 || true)"
X64_TAR="$(find_tar x64 || true)"
missing=""
[[ -n "$ARM_TAR" ]] || missing="arm64"
[[ -n "$X64_TAR" ]] || missing="${missing:+$missing }x64"
if [[ "${DRIVEBAY_DMG_REQUIRE_BOTH:-}" == "1" && -n "$missing" ]]; then
  printf '%s\n' "Missing darwin tarballs: $missing" >&2
  exit 1
fi
if [[ -z "$ARM_TAR" && -z "$X64_TAR" ]]; then
  printf '%s\n' "No drivebay-server-darwin-*.tar.gz found under $INPUT" >&2
  exit 1
fi

mkdir -p "$OUT"

STUB=""
DMG_MOUNT=""
cleanup_all() {
  if [[ -n "$DMG_MOUNT" ]]; then
    hdiutil detach "$DMG_MOUNT" -quiet >/dev/null 2>&1 || true
    DMG_MOUNT=""
  fi
  if [[ -n "$STUB" && -f "$STUB" ]]; then
    rm -f "$STUB"
  fi
}
trap cleanup_all EXIT
if [[ "$LAYOUT_ONLY" != "1" ]]; then
  if ! command -v clang >/dev/null 2>&1; then
    printf '%s\n' "clang is required to build Drivebay.app on macOS." >&2
    exit 1
  fi
  STUB="$(mktemp)"
  clang -arch arm64 -arch x86_64 -Os -mmacosx-version-min=11.0 \
    -o "$STUB" "$HERE/launcher.c"
  info="$(lipo -info "$STUB")"
  printf '%s\n' "$info"
  if ! printf '%s\n' "$info" | grep -q "arm64" || ! printf '%s\n' "$info" | grep -q "x86_64"; then
    printf '%s\n' "Drivebay.app executable must include arm64 and x86_64." >&2
    exit 1
  fi
fi

write_icon() {
  local dest="$1"
  local png="$ROOT/icon.png"
  [[ -f "$png" ]] || return 0
  command -v sips >/dev/null 2>&1 || return 0
  command -v iconutil >/dev/null 2>&1 || return 0
  local iconset
  iconset="$(mktemp -d)/Drivebay.iconset"
  mkdir -p "$iconset"
  local size dbl
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$png" --out "$iconset/icon_${size}x${size}.png" >/dev/null
    dbl=$((size * 2))
    sips -z "$dbl" "$dbl" "$png" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$iconset" -o "$dest/Contents/Resources/Drivebay.icns" || true
}

write_plist() {
  local dest="$1"
  local icon_key=""
  if [[ -f "$dest/Contents/Resources/Drivebay.icns" ]]; then
    icon_key="  <key>CFBundleIconFile</key><string>Drivebay</string>"
  fi
  cat > "$dest/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Drivebay</string>
  <key>CFBundleDisplayName</key><string>Drivebay</string>
  <key>CFBundleIdentifier</key><string>com.mesaandmoon.drivebay.installer</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleSignature</key><string>????</string>
  <key>CFBundleExecutable</key><string>Drivebay</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
${icon_key}
</dict>
</plist>
EOF
  printf '%s' 'APPL????' > "$dest/Contents/PkgInfo"
}

write_readme() {
  local dest="$1"
  local arch="$2"
  cat > "$dest" <<EOF
Drivebay ${VERSION} (${arch})

1. Drag Drivebay onto the Applications folder.
2. This build is not signed or notarized yet. If macOS says it cannot be opened, right-click Drivebay and choose Open, then click Open.
   Or, in Terminal:
     xattr -dr com.apple.quarantine /Applications/Drivebay.app
3. Drivebay asks for the mode, a port, a username, and a password, then installs a login item so it starts when you log in.
4. On this Mac, open http://127.0.0.1:8765/settings (or the port you chose).

The terminal archive is still on the release as drivebay-server-darwin-${arch}.tar.gz.
Uninstall with: bash ~/.local/share/drivebay/program/uninstall.sh
EOF
}

stage_app() {
  local arch="$1"
  local tar_path="$2"
  local stage="$3"
  local app="$stage/Drivebay.app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/payload"
  tar -xzf "$tar_path" -C "$app/Contents/Resources/payload"
  chmod +x "$app/Contents/Resources/payload/unix/"*.sh 2>/dev/null || true
  if [[ -d "$app/Contents/Resources/payload/runtime/bin" ]]; then
    chmod +x "$app/Contents/Resources/payload/runtime/bin/"* 2>/dev/null || true
  fi
  cp "$HERE/drivebay-setup.sh" "$app/Contents/Resources/drivebay-setup.sh"
  chmod +x "$app/Contents/Resources/drivebay-setup.sh"
  if [[ -n "$STUB" ]]; then
    cp "$STUB" "$app/Contents/MacOS/Drivebay"
  else
    cat > "$app/Contents/MacOS/Drivebay" <<'EOF'
#!/bin/bash
here="$(cd "$(dirname "$0")" && pwd)"
exec /bin/bash "$here/../Resources/drivebay-setup.sh"
EOF
  fi
  chmod +x "$app/Contents/MacOS/Drivebay"
  write_icon "$app"
  write_plist "$app"
  write_readme "$stage/README.txt" "$arch"
  cp "$stage/README.txt" "$app/Contents/Resources/README.txt"
  ln -s /Applications "$stage/Applications"
}

create_dmg() {
  local arch="$1"
  local stage="$2"
  local dmg="$OUT/Drivebay-${VERSION}-${arch}.dmg"
  local vol="Drivebay"
  if [[ -d "/Volumes/$vol" ]]; then
    vol="Drivebay-${arch}"
  fi
  local work mount device size_mb
  work="$(mktemp -d)"
  size_mb="$(du -sm "$stage" | awk '{print $1}')"
  size_mb=$((size_mb + size_mb / 5 + 32))
  if [[ "$size_mb" -lt 50 ]]; then size_mb=50; fi
  hdiutil create -size "${size_mb}m" -fs HFS+ -volname "$vol" -ov "$work/rw.dmg" >/dev/null
  local attach
  attach="$(hdiutil attach -readwrite -noverify -noautoopen "$work/rw.dmg")"
  device="$(printf '%s\n' "$attach" | awk 'NR==1 {print $1}')"
  mount="$(printf '%s\n' "$attach" | sed -n 's#.*\(/Volumes/.*\)#\1#p' | head -n 1)"
  if [[ -z "$mount" || ! -d "$mount" ]]; then
    if [[ -n "$device" ]]; then
      hdiutil detach "$device" -force >/dev/null 2>&1 || true
    fi
    printf '%s\n' "Could not mount the disk image." >&2
    printf '%s\n' "$attach" >&2
    exit 1
  fi
  DMG_MOUNT="$mount"
  cp -R "$stage/Drivebay.app" "$mount/Drivebay.app"
  cp "$stage/README.txt" "$mount/README.txt"
  rm -rf "$mount/Applications"
  ln -s /Applications "$mount/Applications"
  rm -rf "$mount/.fseventsd" "$mount/.Trashes" "$mount/.DS_Store"
  sync
  hdiutil detach "$mount" -quiet || hdiutil detach "$device" -force
  DMG_MOUNT=""
  rm -f "$dmg"
  hdiutil convert "$work/rw.dmg" -format UDZO -imagekey zlib-level=9 -o "$dmg" >/dev/null
  rm -rf "$work"

  local verify mount2
  verify="$(hdiutil attach -nobrowse -readonly -noverify -noautoopen "$dmg")"
  mount2="$(printf '%s\n' "$verify" | sed -n 's#.*\(/Volumes/.*\)#\1#p' | head -n 1)"
  DMG_MOUNT="$mount2"
  if [[ ! -d "$mount2/Drivebay.app/Contents/MacOS" || ! -L "$mount2/Applications" || ! -f "$mount2/README.txt" ]]; then
    printf '%s\n' "Disk image is missing Drivebay.app, the Applications shortcut, or the readme." >&2
    hdiutil detach "$mount2" -quiet || true
    exit 1
  fi
  if ! grep -q "xattr -dr com.apple.quarantine" "$mount2/README.txt"; then
    printf '%s\n' "Disk image readme is missing the quarantine step." >&2
    hdiutil detach "$mount2" -quiet || true
    exit 1
  fi
  if ! /usr/bin/file "$mount2/Drivebay.app/Contents/MacOS/Drivebay" | grep -q "Mach-O"; then
    printf '%s\n' "Drivebay.app executable is not a Mach-O binary." >&2
    hdiutil detach "$mount2" -quiet || true
    exit 1
  fi
  hdiutil detach "$mount2" -quiet
  DMG_MOUNT=""
  printf '%s\n' "$dmg"
}

build_one() {
  local arch="$1"
  local tar_path="$2"
  [[ -n "$tar_path" ]] || return 0
  local stage
  stage="$(mktemp -d)"
  stage_app "$arch" "$tar_path" "$stage"
  if [[ "$LAYOUT_ONLY" == "1" ]]; then
    local layout="$OUT/dmg-layout-${arch}"
    rm -rf "$layout"
    mkdir -p "$layout"
    cp -R "$stage/Drivebay.app" "$layout/Drivebay.app"
    cp "$stage/README.txt" "$layout/README.txt"
    ln -s /Applications "$layout/Applications"
    printf '%s\n' "$layout"
  else
    bash "$HERE/sign-dmg.sh" sign "$stage/Drivebay.app"
    create_dmg "$arch" "$stage"
    bash "$HERE/sign-dmg.sh" notarize "$OUT/Drivebay-${VERSION}-${arch}.dmg"
  fi
  rm -rf "$stage"
}

build_one arm64 "$ARM_TAR"
build_one x64 "$X64_TAR"
