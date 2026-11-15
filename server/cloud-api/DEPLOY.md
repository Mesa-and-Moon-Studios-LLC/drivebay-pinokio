# Deploy the Drivebay cloud API

This folder is the Mesa and Moon account API for Drivebay. It is meant for HostGator shared hosting at `mesaandmoon.com`, the same style as the games' `api/*.php` scripts. Nothing in this repo deploys it. Do not point a release at it until the steps below are done.

The API stores connection info only: machine id, display name, type (`pc`, `mac`, `linux`, `phone`), Tailscale address, LAN address, port, public key, last seen, a hidden flag, and a public address only when that machine says the owner opened a port. It does not store files, file lists, passwords, phone codes, or pair tokens. Drivebay does not relay file bytes through this server.

## 1. Firebase

1. Open the same Firebase project the Mesa and Moon vault games use, or create a Drivebay app in that project.
2. Enable Google, Apple, and Email/Password. In Authentication → Sign-in method, turn on Email/Password. Leave Email link (passwordless) off. Drivebay uses a password plus the reset email.
3. Authorized domains: add `localhost` and `127.0.0.1` if they are not already there. Google and Apple redirect to `http://127.0.0.1:<port>/settings`. The Android app uses `drivebay://mesa`. Email/password does not use that redirect. It posts to Identity Toolkit from the settings page.
4. Password reset: Authentication → Templates → Password reset. Leave the action URL on the default Firebase handler (`https://<project>.firebaseapp.com/__/auth/action`) unless you already host a custom handler. The sender name can say Mesa and Moon. Drivebay calls `accounts:sendOobCode` with `PASSWORD_RESET`. It does not add a new config key for the template.
5. One account per email stays on (Firebase default). Drivebay does not link a password onto a Google or Apple user. If the email already exists, the person uses that button. Do not turn off email enumeration protection for this. The reset email still says the link is on its way even when Firebase hides whether the address exists.
6. Copy the web config into `mesa-firebase.json` on each Drivebay machine (see the example in this folder). Put it in the Drivebay data directory (`DRIVEBAY_HOME` or `DRIVEBAY_DATA_DIR`). Fill `apiKey`, `authDomain`, `projectId`, `googleClientId`, `appleClientId`, and `cloudApi`. `authEmulator` stays empty. It is only for a loopback Identity Toolkit emulator during development. Do not commit `mesa-firebase.json`.
7. Copy the Firebase project id into `config.php` on the server. The PHP check accepts ID tokens whose `firebase.sign_in_provider` is `password`, `google.com`, or `apple.com`. No new server key is required for email.

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
