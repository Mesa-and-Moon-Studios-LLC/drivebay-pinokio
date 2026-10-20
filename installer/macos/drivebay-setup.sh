#!/bin/bash
# Double-click setup for the macOS disk image.
# Collects the same answers as unix/install.sh (mode, port, username, password)
# with osascript, then runs that script so the LaunchAgent stays one path.
# Bash 3.2 (the macOS /bin/bash) is enough.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ -d "$SCRIPT_DIR/payload/unix" ]]; then
  PAYLOAD="$(cd "$SCRIPT_DIR/payload" && pwd)"
elif [[ -d "$SCRIPT_DIR/../Resources/payload/unix" ]]; then
  PAYLOAD="$(cd "$SCRIPT_DIR/../Resources/payload" && pwd)"
else
  PAYLOAD="${DRIVEBAY_SOURCE:-}"
fi

if [[ -z "$PAYLOAD" || ! -d "$PAYLOAD" ]]; then
  printf '%s\n' "Drivebay payload is missing." >&2
  exit 1
fi

APP_ROOT=""
if [[ "$(basename "$(dirname "$SCRIPT_DIR")")" == "Contents" ]]; then
  APP_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
fi

INSTALL_SH="${DRIVEBAY_INSTALL_SH:-$PAYLOAD/unix/install.sh}"
HOME_DIR="${DRIVEBAY_HOME:-$HOME/.local/share/drivebay}"

if [[ ! -f "$INSTALL_SH" ]]; then
  printf '%s\n' "Missing installer: $INSTALL_SH" >&2
  exit 1
fi

if [[ "$(uname -s)" == "Darwin" && "${DRIVEBAY_SKIP_XATTR:-}" != "1" ]] && command -v xattr >/dev/null 2>&1; then
  xattr -dr com.apple.quarantine "$PAYLOAD" 2>/dev/null || true
  if [[ -n "$APP_ROOT" ]]; then
    xattr -dr com.apple.quarantine "$APP_ROOT" 2>/dev/null || true
  fi
fi

as_quote() {
  local s="$1"
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\r'/ }
  s=${s//$'\n'/ }
  printf '"%s"' "$s"
}

osascript_eval() {
  local script="$1"
  local out status
  set +e
  if [[ -n "${DRIVEBAY_OSASCRIPT:-}" ]]; then
    out=$(printf '%s\n' "$script" | "$DRIVEBAY_OSASCRIPT")
    status=$?
  else
    out=$(printf '%s\n' "$script" | osascript -)
    status=$?
  fi
  set -e
  if [[ "$status" -ne 0 ]]; then
    return "$status"
  fi
  printf '%s' "$out"
}

consume_reply() {
  local line rest
  [[ -f "${DRIVEBAY_UI_REPLIES:-}" ]] || return 1
  IFS= read -r line < "$DRIVEBAY_UI_REPLIES" || return 1
  rest="$(mktemp)"
  tail -n +2 "$DRIVEBAY_UI_REPLIES" > "$rest" || true
  mv "$rest" "$DRIVEBAY_UI_REPLIES"
  if [[ "$line" == "cancel" || "$line" == "no" ]]; then
    return 1
  fi
  if [[ "$line" == "yes" || "$line" == "ok" ]]; then
    return 0
  fi
  printf '%s' "$line"
}

# kind is choose, text, secret, confirm, or alert.
# Alerts do not consume scripted replies.
call_ui() {
  local kind="$1"
  shift
  if [[ -n "${DRIVEBAY_UI_REPLIES:-}" ]]; then
    if [[ "$kind" == "alert" ]]; then
      return 0
    fi
    consume_reply || return 1
    return 0
  fi
  if [[ -z "${DRIVEBAY_OSASCRIPT:-}" ]] && ! command -v osascript >/dev/null 2>&1; then
    printf '%s\n' "osascript is required to set up Drivebay." >&2
    return 1
  fi
  case "$kind" in
    choose)
      local prompt="$1"
      shift
      local first="$1"
      local items="" item
      for item in "$@"; do
        if [[ -n "$items" ]]; then items="$items, "; fi
        items="$items$(as_quote "$item")"
      done
      osascript_eval "set picked to choose from list {${items}} with title \"Drivebay\" with prompt $(as_quote "$prompt") default items {$(as_quote "$first")}
if picked is false then error number -128
return item 1 of picked" || return 1
      ;;
    text)
      local prompt="$1"
      local def="${2:-}"
      osascript_eval "set r to display dialog $(as_quote "$prompt") default answer $(as_quote "$def") buttons {\"Cancel\", \"Continue\"} default button \"Continue\" with title \"Drivebay\"
return text returned of r" || return 1
      ;;
    secret)
      local prompt="$1"
      osascript_eval "set r to display dialog $(as_quote "$prompt") default answer \"\" with hidden answer buttons {\"Cancel\", \"Continue\"} default button \"Continue\" with title \"Drivebay\"
return text returned of r" || return 1
      ;;
    confirm)
      local prompt="$1"
      osascript_eval "display dialog $(as_quote "$prompt") buttons {\"Cancel\", \"Continue\"} default button \"Continue\" with title \"Drivebay\"" >/dev/null || return 1
      ;;
    alert)
      local prompt="$1"
      prompt="${prompt:0:400}"
      osascript_eval "display dialog $(as_quote "$prompt") buttons {\"OK\"} default button \"OK\" with title \"Drivebay\"" >/dev/null || true
      ;;
    *)
      printf '%s\n' "Unknown prompt: $kind" >&2
      return 1
      ;;
  esac
}

read_port() {
  local file="$1"
  local fallback="$2"
  if [[ ! -f "$file" ]]; then
    printf '%s' "$fallback"
    return
  fi
  python3 - "$file" "$fallback" <<'PY'
import json, sys
fallback = sys.argv[2]
try:
    data = json.load(open(sys.argv[1]))
    print(data.get("port", fallback))
except Exception:
    print(fallback)
PY
}

payload_version() {
  local line=""
  if [[ -f "$PAYLOAD/VERSION.txt" ]]; then
    line="$(head -n 1 "$PAYLOAD/VERSION.txt")"
  fi
  printf '%s\n' "$line" | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -n 1 || true
}

config_version() {
  [[ -f "$HOME_DIR/config.json" ]] || return 0
  python3 - "$HOME_DIR/config.json" <<'PY'
import json, sys
try:
    print(json.load(open(sys.argv[1])).get("version", ""))
except Exception:
    print("")
PY
}

open_url() {
  local url="$1"
  if [[ -n "${DRIVEBAY_OPEN:-}" ]]; then
    "$DRIVEBAY_OPEN" "$url"
    return
  fi
  if [[ "$(uname -s)" == "Darwin" ]] && command -v open >/dev/null 2>&1; then
    open "$url"
  fi
}

finish_open() {
  local message="$1"
  local fallback="${2:-8765}"
  local port_now url
  port_now="$(read_port "$HOME_DIR/config.json" "$fallback")"
  url="http://127.0.0.1:${port_now}/settings"
  call_ui alert "${message} ${url}" || true
  open_url "$url"
}

run_install() {
  local mode="${1:-}" port="${2:-}" user_name="${3:-}" pass="${4:-}"
  local log status msg
  log="$(mktemp)"
  if [[ -n "$mode" ]]; then export DRIVEBAY_SETUP_MODE="$mode"; else unset DRIVEBAY_SETUP_MODE || true; fi
  if [[ -n "$port" ]]; then export DRIVEBAY_PORT="$port"; else unset DRIVEBAY_PORT || true; fi
  if [[ -n "$user_name" ]]; then export DRIVEBAY_USER="$user_name"; else unset DRIVEBAY_USER || true; fi
  if [[ -n "$pass" ]]; then export DRIVEBAY_PASSWORD="$pass"; else unset DRIVEBAY_PASSWORD || true; fi
  export DRIVEBAY_SOURCE="$PAYLOAD"
  set +e
  bash "$INSTALL_SH" >"$log" 2>&1
  status=$?
  set -e
  unset DRIVEBAY_PASSWORD || true
  if [[ "$status" -ne 0 ]]; then
    msg="$(tail -n 20 "$log" | tr '\n' ' ')"
    if [[ -n "$pass" ]]; then
      msg="$(printf '%s' "$msg" | python3 -c 'import sys; p=sys.argv[1]; print(sys.stdin.read().replace(p, "[redacted]"), end="")' "$pass")"
    fi
    rm -f "$log"
    call_ui alert "Drivebay setup failed. ${msg}" || true
    exit 1
  fi
  rm -f "$log"
}

installed="$(config_version || true)"
coming="$(payload_version || true)"
if [[ -f "$HOME_DIR/config.json" ]]; then
  if [[ -n "$installed" && "$installed" == "$coming" ]]; then
    finish_open "Drivebay ${coming} is already installed. Opening settings."
    exit 0
  fi
  if ! call_ui confirm "Update Drivebay to ${coming}? Your account, port, and settings stay."; then
    exit 0
  fi
  run_install
  finish_open "Drivebay is updated to ${coming}."
  exit 0
fi

mode_label="$(call_ui choose "How should other devices reach this Mac?" \
  "Tailscale (recommended)" \
  "Tailscale + Local (Both)" \
  "No Tailscale (Regular mode)")" || exit 0

mode="tailscale"
case "$mode_label" in
  "Tailscale + Local (Both)") mode="both" ;;
  "No Tailscale (Regular mode)") mode="regular" ;;
  *) mode="tailscale" ;;
esac

port=""
while true; do
  port="$(call_ui text "Port (1024-65535)" "8765")" || exit 0
  if [[ "$port" =~ ^[0-9]+$ ]] && [[ "$port" -ge 1024 ]] && [[ "$port" -le 65535 ]]; then
    break
  fi
  call_ui alert "Port must be a number from 1024 to 65535." || true
done

if [[ "$mode" == "regular" ]]; then
  call_ui confirm "Forward TCP port ${port} on your router so other devices can reach this Mac. Continue?" || exit 0
elif [[ "$mode" == "both" ]]; then
  call_ui confirm "Both mode starts with public access off. Forward TCP port ${port} only if you turn public access on later. Continue?" || exit 0
else
  call_ui alert "Other devices use http://<this-mac-tailscale-name>:${port}/ after Tailscale is signed in. Nothing is opened to the internet." || true
fi

user_name=""
while true; do
  user_name="$(call_ui text "Username" "")" || exit 0
  if [[ -n "$user_name" ]]; then
    break
  fi
  call_ui alert "Enter a username." || true
done

password=""
again=""
while true; do
  password="$(call_ui secret "Password (at least 8 characters)")" || exit 0
  if [[ ${#password} -lt 8 ]]; then
    call_ui alert "Use a password of at least 8 characters." || true
    continue
  fi
  again="$(call_ui secret "Confirm password")" || exit 0
  if [[ "$password" != "$again" ]]; then
    call_ui alert "Passwords do not match." || true
    continue
  fi
  break
done

run_install "$mode" "$port" "$user_name" "$password"
unset password again || true
finish_open "Drivebay is installed and will start when you log in." "$port"
