# Deploy the Drivebay cloud API

This folder is the Mesa and Moon account API for Drivebay. It is meant for HostGator shared hosting at `mesaandmoon.com`, the same style as the games' `api/*.php` scripts. Nothing in this repo deploys it. Do not point a release at it until the steps below are done.

The API stores connection info only: machine id, display name, type (`pc`, `mac`, `linux`, `phone`), Tailscale address, LAN address, port, public key, last seen, a hidden flag, and a public address only when that machine says the owner opened a port. It does not store files, file lists, passwords, phone codes, or pair tokens. Drivebay does not relay file bytes through this server.

## 1. Firebase

1. Open the same Firebase project the Mesa and Moon vault games use, or create a Drivebay app in that project.
2. Enable Google and Apple sign-in.
3. Add authorized domains for the addresses Drivebay will redirect to. Each machine's settings page is `http://127.0.0.1:<port>/settings`. Google and Apple also need that redirect. The Android app uses `drivebay://mesa`.
4. Copy the web config into `mesa-firebase.json` on each Drivebay machine (see the example in this folder). Put it in the Drivebay data directory (`DRIVEBAY_HOME` or `DRIVEBAY_DATA_DIR`). Do not commit it.
5. Copy the Firebase project id into `config.php` on the server.

## 2. MySQL

1. Create a database and user in cPanel.
2. Import `schema.sql` in phpMyAdmin.
3. Copy `config.example.php` to `config.php` next to `schema.sql` and fill in the database user, password, and Firebase project id.
4. Leave `config.php` out of git. The `.htaccess` in this folder denies it. If the host allows it, move `config.php` outside `public_html` and point `bootstrap.php` at that path.

## 3. Upload

Upload this folder to `public_html/drivebay/` so the scripts are:

- `https://mesaandmoon.com/drivebay/api/health.php`
- `https://mesaandmoon.com/drivebay/api/machines.php`

`mesa-firebase.json` on each machine then uses:

```json
"cloudApi": "https://mesaandmoon.com/drivebay/api"
```

Open `health.php` in a browser. It should say `"stores":"connection"`. `machines.php` without a Firebase ID token should say sign-in is required.

PHP needs PDO MySQL, OpenSSL, and either curl or `allow_url_fopen` so it can download Google's Firebase signing certificates.

## 4. What a machine sends

`POST api/machines.php` with `Authorization: Bearer <Firebase ID token>` and a JSON body of connection fields only. Any other field, including a password, token, code, or folder, is rejected and nothing is written.

`GET api/machines.php?self=<this machine id>` returns the caller's machines. A hidden machine is omitted for the others and still returned to itself.

There is no upload URL and no WebDAV proxy here. File traffic stays on Tailscale, or on a port the owner forwarded on purpose.
