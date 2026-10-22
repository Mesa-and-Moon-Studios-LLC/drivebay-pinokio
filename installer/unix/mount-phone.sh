#!/usr/bin/env bash
# Mount the phone from a shell. The token is read from the prompt, not from the command line.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${DRIVEBAY_NODE:-node}"
URL="${1:-${DRIVEBAY_PHONE_URL:-}}"
LETTER="${2:-${DRIVEBAY_PHONE_LETTER:-Z}}"
if [[ -z "$URL" ]]; then
  if [[ -t 0 ]]; then
    read -r -p "Phone address: " URL
  else
    echo "Set DRIVEBAY_PHONE_URL. Drivebay does not prompt when there is no terminal." >&2
    exit 1
  fi
fi
if [[ -z "${DRIVEBAY_PHONE_SECRET:-}" ]]; then
  if [[ -t 0 ]]; then
    read -r -s -p "Token: " SECRET
    printf '\n'
    export DRIVEBAY_PHONE_SECRET="$SECRET"
    unset SECRET
  else
    echo "Set DRIVEBAY_PHONE_SECRET. Drivebay does not prompt when there is no terminal." >&2
    exit 1
  fi
fi
export DRIVEBAY_PHONE_URL="$URL"
export DRIVEBAY_PHONE_LETTER="$LETTER"
exec "$NODE" "$ROOT/phone-drive.mjs"
