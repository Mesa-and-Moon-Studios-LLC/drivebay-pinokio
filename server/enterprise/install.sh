#!/bin/sh
# Simple installer for the Drivebay Enterprise cloud API. Run from this folder: sh install.sh /path/to/your.dbaylicense
set -e
cd "$(dirname "$0")"
command -v docker >/dev/null 2>&1 || { echo "Docker is required. Install Docker Engine and the compose plugin first." >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "The docker compose plugin is required." >&2; exit 1; }
[ -f .env ] || cp .env.example .env
if ! grep -q '^DRIVEBAY_FIREBASE_PROJECT_ID=.\+' .env; then
  printf 'Your Firebase project id: '
  read -r pid
  [ -n "$pid" ] || { echo "A Firebase project id is required." >&2; exit 1; }
  sed -i.bak "s/^DRIVEBAY_FIREBASE_PROJECT_ID=.*/DRIVEBAY_FIREBASE_PROJECT_ID=$pid/" .env && rm -f .env.bak
fi
mkdir -p data
chmod 700 data
if [ -n "$1" ]; then
  cp "$1" data/license.dbaylicense
  chmod 600 data/license.dbaylicense
fi
[ -f data/license.dbaylicense ] || echo "Note: no license file yet. Copy it to enterprise/data/license.dbaylicense, then run: docker compose restart" >&2
docker compose up -d --build
echo "Started. Check the license: curl -s http://127.0.0.1:\${DRIVEBAY_PORT:-8080}/api/enterprise-license.php"
