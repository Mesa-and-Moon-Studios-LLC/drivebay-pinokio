#!/bin/sh
# Writes the cloud API config from environment variables on first start, then hands off to Apache.
set -e
: "${DRIVEBAY_FIREBASE_PROJECT_ID:?Set DRIVEBAY_FIREBASE_PROJECT_ID (your own Firebase project id) in .env}"
mkdir -p /data
chown www-data:www-data /data
chmod 700 /data
cat > /var/www/html/config.php <<PHP
<?php
return [
    'sqlite_path' => '/data/drivebay.sqlite',
    'firebase_project_id' => getenv('DRIVEBAY_FIREBASE_PROJECT_ID'),
];
PHP
if [ ! -f /data/license.dbaylicense ]; then
  echo "drivebay: no /data/license.dbaylicense yet. The server runs, but new machines are refused until you add your Enterprise license file." >&2
fi
exec docker-php-entrypoint "$@"
