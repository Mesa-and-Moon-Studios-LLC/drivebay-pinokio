#!/usr/bin/env bash
# Removes the Drivebay program, login item, and command. Asks before deleting the account.
set -euo pipefail
HOME_DIR="${DRIVEBAY_HOME:-$HOME/.local/share/drivebay}"
BIN_DIR="${DRIVEBAY_BIN_DIR:-$HOME/.local/bin}"

if [[ -x "$BIN_DIR/drivebay" ]]; then
  DRIVEBAY_HOME="$HOME_DIR" "$BIN_DIR/drivebay" --stop || true
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
  launchctl bootout "gui/$(id -u)/com.mesaandmoon.drivebay" >/dev/null 2>&1 || true
  rm -f "$HOME/Library/LaunchAgents/com.mesaandmoon.drivebay.plist"
elif command -v systemctl >/dev/null 2>&1; then
  systemctl --user disable --now drivebay.service >/dev/null 2>&1 || true
  rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/drivebay.service"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
fi

# Catch a server child the launcher left behind.
pkill -f "$HOME_DIR/program/app/server/index.mjs" >/dev/null 2>&1 || true
rm -f "$BIN_DIR/drivebay"
rm -rf "$HOME_DIR/program"

keep="${DRIVEBAY_UNINSTALL_KEEP_DATA:-}"
force="${DRIVEBAY_UNINSTALL_FORCE:-}"
if [[ "$keep" == "1" ]]; then
  printf '%s\n' "Drivebay is uninstalled. The account and settings were kept."
  exit 0
fi
if [[ "$force" == "1" ]]; then
  rm -rf "$HOME_DIR"
  printf '%s\n' "Drivebay is uninstalled."
  exit 0
fi
if [[ -t 0 ]]; then
  read -r -p "Delete the saved account and settings? Type YES: " reply || true
  if [[ "$reply" == "YES" ]]; then
    rm -rf "$HOME_DIR"
  fi
fi
printf '%s\n' "Drivebay is uninstalled."
