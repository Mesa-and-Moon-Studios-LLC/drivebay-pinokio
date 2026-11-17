# Drivebay Enterprise self-host: admin guide

You need: a Linux server with Docker and the compose plugin, a TLS reverse proxy, your `.dbaylicense` file from Mesa and Moon, and your own Firebase project (Authentication only, free plan) for sign-in.

## Install

```
cd server/enterprise
sh install.sh /path/to/your.dbaylicense
```

The script creates `.env` (asks for your Firebase project id), copies the license to `data/license.dbaylicense`, and runs `docker compose up -d --build`. The API listens on `127.0.0.1:8080`. Put Caddy, nginx or Traefik with TLS in front, for example `https://drivebay.yourcompany.com`.

Point each Drivebay app at it: in `mesa-firebase.json` set `"cloudApi": "https://drivebay.yourcompany.com/api"` along with your Firebase web config (see `server/cloud-api/DEPLOY.md`, section 1).

## Check the license

```
curl -s https://drivebay.yourcompany.com/api/enterprise-license.php
```

Shows `state` (`ok`, `missing`, `invalid`, `expired`, `updates_ended`, `not_enterprise`), seats, machines registered, term end, and updates-until date. The key itself is never shown.

## Rules

- Seats are machines (PCs, Macs and phones). A new machine beyond the seat count gets HTTP 402 `seats_full`. Remove machines from the app, or ask for more seats.
- An expired, missing or invalid license never locks out existing machines. It only refuses new ones.
- "Updates until" compares with the date the image was built. After it passes, images built later report `updates_ended`. Keep running the image you have, or renew updates.
- The license is checked on your server. Nothing is sent to Mesa and Moon.

## Renew or change

Replace `data/license.dbaylicense` with the new file and run `docker compose restart`. No data changes.

## Back up

Back up `data/` (the machine directory in `drivebay.sqlite`, plus the license file). It holds only encrypted records. File contents never reach this server.

## Upgrade

Pull the new source, then `docker compose up -d --build`.
