#!/usr/bin/env bash
# First-run setup for Drivebay on macOS and Linux.
# Unsigned on macOS until DRIVEBAY_CODESIGN_IDENTITY is set. See sign-mac.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
if [[ -f "$ROOT/launcher.mjs" ]]; then
  SOURCE="$ROOT"
elif [[ -f "$ROOT/../launcher.mjs" ]]; then
  SOURCE="$(cd "$ROOT/.." && pwd)"
else
  SOURCE="${DRIVEBAY_SOURCE:-$ROOT}"
fi
SOURCE="${DRIVEBAY_SOURCE:-$SOURCE}"

HOME_DIR="${DRIVEBAY_HOME:-$HOME/.local/share/drivebay}"
BIN_DIR="${DRIVEBAY_BIN_DIR:-$HOME/.local/bin}"
NODE_VERSION="$(tr -d '[:space:]' < "$SOURCE/node-version.txt" 2>/dev/null || tr -d '[:space:]' < "$SOURCE/installer/node-version.txt")"
VERSION_LINE="$(head -n 1 "$SOURCE/VERSION.txt" 2>/dev/null || echo "Drivebay 3.37.0")"
VERSION="$(printf '%s\n' "$VERSION_LINE" | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -n 1)"
VERSION="${VERSION:-3.37.0}"

# No desktop session (SSH or a headless server): do not try to open a browser.
if [[ "$(uname -s)" != "Darwin" && -z "${DISPLAY:-}" && -z "${WAYLAND_DISPLAY:-}" ]]; then
  export DRIVEBAY_NO_BROWSER=1
fi
if [[ "$(uname -s)" == "Darwin" && -n "${SSH_CONNECTION:-}" ]]; then
  export DRIVEBAY_NO_BROWSER=1
fi

say() { printf '%s\n' "$*"; }

prompt() {
  local label="$1"
  local def="${2:-}"
  local reply=""
  if [[ -n "$def" ]]; then
    read -r -p "$label [$def]: " reply || true
    printf '%s' "${reply:-$def}"
  else
    read -r -p "$label: " reply || true
    printf '%s' "$reply"
  fi
}

secret() {
  local reply=""
  read -r -s -p "$1: " reply || true
  printf '\n' >&2
  printf '%s' "$reply"
}

port_free() {
  python3 - "$1" <<'PY'
import socket, sys
port = int(sys.argv[1])
sock = socket.socket()
sock.settimeout(0.4)
try:
    sock.connect(("127.0.0.1", port))
except Exception:
    sys.exit(0)
else:
    sys.exit(1)
PY
}

json_escape() {
  printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
}

existing=0
if [[ -f "$HOME_DIR/config.json" ]]; then
  existing=1
fi

mode="${DRIVEBAY_SETUP_MODE:-}"
port="${DRIVEBAY_PORT:-}"
user_name="${DRIVEBAY_USER:-}"
password="${DRIVEBAY_PASSWORD:-}"

if [[ "$existing" -eq 0 ]]; then
  say "Drivebay setup"
  say "Tailscale is the usual choice. Nothing is opened to the internet."
  if [[ -z "$mode" ]]; then
    say "1) Tailscale (recommended)"
    say "2) Tailscale + Local (Both)"
    say "3) No Tailscale (Regular mode)"
    choice="$(prompt "Mode" "1")"
    case "$choice" in
      2|both) mode="both" ;;
      3|regular) mode="regular" ;;
      *) mode="tailscale" ;;
    esac
  fi
  if [[ -z "$port" ]]; then
    port="$(prompt "Port" "8765")"
  fi
  if ! [[ "$port" =~ ^[0-9]+$ ]] || [[ "$port" -lt 1024 ]] || [[ "$port" -gt 65535 ]]; then
    say "Port must be a number from 1024 to 65535."
    exit 1
  fi
  if ! port_free "$port"; then
    say "Port $port is already in use."
    exit 1
  fi
  if [[ "$mode" == "regular" || "$mode" == "both" ]]; then
    say "Forward TCP port $port on your router if other devices are outside Tailscale."
    say "Both mode starts with public access off."
  else
    say "Other devices use http://<this-pc-tailscale-name>:$port/ after Tailscale is signed in."
  fi
  if [[ -z "$user_name" ]]; then
    user_name="$(prompt "Username")"
  fi
  if [[ -z "$password" ]]; then
    password="$(secret "Password")"
    again="$(secret "Confirm password")"
    if [[ "$password" != "$again" ]]; then
      say "Passwords do not match."
      exit 1
    fi
  fi
  if [[ ${#password} -lt 8 || -z "$user_name" ]]; then
    say "Use a username and a password of at least 8 characters."
    exit 1
  fi
else
  say "Drivebay is already installed. This update keeps the account, port, and settings."
  say "If this version is below the published minimum, the update is required."
fi

mkdir -p "$HOME_DIR/program" "$HOME_DIR/data" "$BIN_DIR"
# Stop a running copy before its program files are replaced.
if [[ "$existing" -eq 1 && -x "$BIN_DIR/drivebay" ]]; then
  "$BIN_DIR/drivebay" --stop >/dev/null 2>&1 || true
fi
# Program files only. config.json, data, and pending-account.json stay put.
if [[ -d "$SOURCE/app" ]]; then
  rm -rf "$HOME_DIR/program/app"
  cp -R "$SOURCE/app" "$HOME_DIR/program/app"
fi
for name in launcher.mjs lib.mjs reset-password.mjs update-policy.mjs update-apply.mjs phone-drive.mjs phone-drive-lib.mjs VERSION.txt version-manifest.json; do
  if [[ -f "$SOURCE/$name" ]]; then
    cp "$SOURCE/$name" "$HOME_DIR/program/$name"
  fi
done
if [[ -f "$SOURCE/unix/uninstall.sh" ]]; then
  cp "$SOURCE/unix/uninstall.sh" "$HOME_DIR/program/uninstall.sh"
  chmod +x "$HOME_DIR/program/uninstall.sh"
fi

if [[ "${DRIVEBAY_SKIP_NODE:-}" != "1" ]]; then
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$os" in
    darwin) node_os="darwin" ;;
    linux) node_os="linux" ;;
    *) say "This installer supports macOS and Linux."; exit 1 ;;
  esac
  case "$arch" in
    x86_64|amd64) node_arch="x64" ;;
    arm64|aarch64) node_arch="arm64" ;;
    *) say "Unsupported CPU: $arch"; exit 1 ;;
  esac
  if [[ "$(uname -s)" == "Darwin" && -x "$SOURCE/unix/sign-mac.sh" ]]; then
    bash "$SOURCE/unix/sign-mac.sh" || true
  fi
  bundle="$SOURCE/runtime/bin/node"
  if [[ ! -x "$bundle" ]]; then
    tar_name="node-v${NODE_VERSION}-${node_os}-${node_arch}.tar.gz"
    url="https://nodejs.org/dist/v${NODE_VERSION}/${tar_name}"
    tmp="$(mktemp -d)"
    say "Downloading $url"
    curl -fsSL "$url" -o "$tmp/$tar_name"
    sums="$(curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt")"
    want="$(printf '%s\n' "$sums" | awk -v name="$tar_name" '$2==name {print $1}')"
    got="$(shasum -a 256 "$tmp/$tar_name" 2>/dev/null | awk '{print $1}' || sha256sum "$tmp/$tar_name" | awk '{print $1}')"
    if [[ -z "$want" || "$want" != "$got" ]]; then
      say "Node checksum mismatch."
      exit 1
    fi
    tar -xzf "$tmp/$tar_name" -C "$tmp"
    rm -rf "$HOME_DIR/program/runtime"
    mv "$tmp/node-v${NODE_VERSION}-${node_os}-${node_arch}" "$HOME_DIR/program/runtime"
    rm -rf "$tmp"
  else
    rm -rf "$HOME_DIR/program/runtime"
    mkdir -p "$HOME_DIR/program/runtime"
    cp -R "$SOURCE/runtime/." "$HOME_DIR/program/runtime/"
  fi
fi

NODE="$HOME_DIR/program/runtime/bin/node"
if [[ ! -x "$NODE" && -x "$HOME_DIR/program/runtime/node" ]]; then
  NODE="$HOME_DIR/program/runtime/node"
fi

if [[ "$existing" -eq 0 ]]; then
  user_json="$(json_escape "$user_name")"
  pass_json="$(json_escape "$password")"
  umask 077
  printf '{"port":%s,"mode":"%s","version":"%s"}\n' "$port" "$mode" "$VERSION" > "$HOME_DIR/config.json"
  printf '%s\n' "$port" > "$HOME_DIR/drivebay.port"
  printf '{"username":%s,"password":%s}\n' "$user_json" "$pass_json" > "$HOME_DIR/pending-account.json"
  chmod 600 "$HOME_DIR/pending-account.json" || true
  unset password again || true
fi

cat > "$BIN_DIR/drivebay" <<EOF
#!/bin/sh
export DRIVEBAY_HOME="$HOME_DIR"
export DRIVEBAY_APP_DIR="$HOME_DIR/program/app"
exec "$NODE" "$HOME_DIR/program/launcher.mjs" "\$@"
EOF
chmod +x "$BIN_DIR/drivebay"

start_login() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    plist="$HOME/Library/LaunchAgents/com.mesaandmoon.drivebay.plist"
    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.mesaandmoon.drivebay</string>
  <key>ProgramArguments</key>
  <array><string>$BIN_DIR/drivebay</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
</dict></plist>
EOF
    launchctl bootout "gui/$(id -u)/com.mesaandmoon.drivebay" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$plist" >/dev/null 2>&1 || launchctl load "$plist" >/dev/null 2>&1 || true
    say "Drivebay starts when you log in to this Mac."
  elif command -v systemctl >/dev/null 2>&1; then
    unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    mkdir -p "$unit_dir"
    cat > "$unit_dir/drivebay.service" <<EOF
[Unit]
Description=Drivebay file server
After=network-online.target

[Service]
ExecStart=$BIN_DIR/drivebay
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload || true
    systemctl --user enable --now drivebay.service || true
    say "Drivebay starts when you log in (systemd user service)."
  else
    say "No systemd user session was found. Start Drivebay with: $BIN_DIR/drivebay"
  fi
}

if [[ "${DRIVEBAY_SKIP_SERVICE:-}" != "1" ]]; then
  start_login
fi

service_started=0
if [[ "${DRIVEBAY_SKIP_SERVICE:-}" != "1" ]]; then
  if [[ "$(uname -s)" == "Darwin" ]]; then
    launchctl print "gui/$(id -u)/com.mesaandmoon.drivebay" >/dev/null 2>&1 && service_started=1
  elif command -v systemctl >/dev/null 2>&1; then
    systemctl --user is-active --quiet drivebay.service 2>/dev/null && service_started=1
  fi
fi
# The login item already starts Drivebay. Otherwise start it in the background so setup returns.
if [[ "${DRIVEBAY_SKIP_START:-}" != "1" && "$service_started" -eq 0 && -x "$NODE" ]]; then
  DRIVEBAY_HOME="$HOME_DIR" DRIVEBAY_APP_DIR="$HOME_DIR/program/app" \
    nohup "$NODE" "$HOME_DIR/program/launcher.mjs" >/dev/null 2>&1 &
  disown || true
fi

if [[ "$existing" -eq 1 ]]; then
  python3 - "$HOME_DIR/config.json" "$VERSION" <<'PY' || true
import json, sys
p, v = sys.argv[1], sys.argv[2]
c = json.load(open(p)); c["version"] = v
open(p, "w").write(json.dumps(c) + "\n")
PY
  say "Drivebay updated to $VERSION"
else
  say "Drivebay is installed. On this PC open http://127.0.0.1:${port:-8765}/settings"
fi
say "Uninstall with: $HOME_DIR/program/uninstall.sh"
