#!/usr/bin/env bash
# Mount the phone from a shell. The token is read from the prompt, not from the command line.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${DRIVEBAY_NODE:-node}"
URL="${1:-${DRIVEBAY_PHONE_URL:-}}"
LETTER="${2:-${DRIVEBAY_PHONE_LETTER:-Z}}"
if [[ -z "$URL" ]]; then
  read -r -p "Phone address: " URL
fi
read -r -s -p "Token: " SECRET
printf '\n'
export DRIVEBAY_PHONE_URL="$URL"
export DRIVEBAY_PHONE_SECRET="$SECRET"
export DRIVEBAY_PHONE_LETTER="$LETTER"
unset SECRET
exec "$NODE" "$ROOT/phone-drive.mjs"
