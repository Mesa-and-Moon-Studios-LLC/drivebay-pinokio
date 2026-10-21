# Drivebay

**[Download for Windows](https://github.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/releases/latest/download/Drivebay-Setup-3.36.4.exe)**

Password-locked file browser for every drive on this machine. Built to run inside [Pinokio](https://pinokio.computer).

**Install this URL in Pinokio:**

```
https://github.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio
```

Current version: **3.36.4** — see [Changelog](#changelog) below.

## Install in Pinokio (do this)

1. Delete any old Drivebay folders first. In File Explorer delete these if they exist:

   - `Z:\pinokio\api\drivebay.git`
   - `Z:\pinokio\api\drivebay`

2. Open **Pinokio**.
3. Go to **Discover** (or **Download from URL**).
4. Paste `https://github.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio` and download.
5. Click **Install**. Choose **Static** (you pick the port) or **Random** (new port each Start).
6. If you chose Static, forward **that same port** on your router.
7. Click **Start**. On this PC, Drivebay opens the settings page. It does not open the file browser. Other devices use the address Pinokio shows.
8. The first visit creates the **only** username and password. Pick something strong — Pinokio is already visible online, and this app can see every file on the machine.
9. After that, anyone who opens it can only unlock. Nobody else can sign up.
10. In the sidebar, open **X:**, **Z:**, and any other drives you want.

Change the port later with **Set port** or the in-app **Settings** page, then Start again.

## Install without Pinokio

Download **Drivebay-Setup-3.36.4.exe** from [GitHub Releases](https://github.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/releases). You do not need Node.js, git, or Pinokio. The installer includes the server and the runtime that runs it, and it starts a production build.

Push a version tag such as `v3.36.4` to publish that file on the release. Pull requests also upload the installer as a build artifact. macOS and Linux archives are built the same way. See [Install on macOS or Linux](#install-on-macos-or-linux).

The setup screens are:

1. **Welcome.** The runtime is included.
2. **Folder.** Where to put the program. This is a per-user install.
3. **Mode.** **Tailscale (Recommended)** is the default. Nothing is opened to the internet, and only your own signed-in devices can reach Drivebay. **Tailscale + Local (Both)** keeps Tailscale and adds a public path that starts off. **No Tailscale (Regular mode)** exposes the port publicly and needs a router port forward.
4. **Tailscale** (Tailscale or Both). The page asks **Do you already have Tailscale?** and selects Yes when Tailscale is already installed. Yes goes on to the port, username, and password. No offers two choices: download and install Tailscale for Windows from the official installer (quiet MSI from `pkgs.tailscale.com`), then sign in or create a free Tailscale account, or **Skip**. Skip says you can install Tailscale and set it up later, then continues.
5. **Port.** Required in every mode. A free port from 1024 to 65535. The suggested port is 8765. Ports from 42000 to 42999 are left for Pinokio's Caddy. This page runs on a first-time install.
6. **Router** (Regular and Both). After the port is chosen, setup prints this PC's local IP, asks you to log in to the router (usually `http://192.168.0.1` or `http://192.168.1.1`), forward TCP **that port** to the local IP, and reserve that IP in DHCP. It prints the public IP when it can, and tells you to open `http://<public-ip>:<port>/` from outside the network. Some ISPs use CGNAT and block this. Tailscale is the easy fallback. Use a strong password. You must check the box to continue. Tailscale-only skips this page. Allow the same port in Windows Firewall if Windows asks. The same steps stay on this PC's settings page while Regular or Both mode is on. In Both, **Public access** starts **Off**. Only this PC can turn it On, with an optional timer of 1 hour, 4 hours, or 24 hours. A public or LAN address cannot change it. While it is Off, those addresses get a refusal page and no sign-in form. The Android app can show this state in a later build.
7. **Password.** The only username and password (at least 8 characters). The first launch asks you to sign in with that account. It does not ask you to create it again. If that account cannot be saved, setup shows the reason and writes the same text to the install log, and the login page then lets you set the lock.
8. **Shortcuts.** Start menu entries (Drivebay, Stop Drivebay, and Uninstall) are always created. They open a notification-area icon, not a console window. Optional desktop shortcut. Optional **Start Drivebay when I sign in to Windows**, which starts that same icon in the background.
9. **Finish.** On this PC, opens the settings page. It does not open the file browser. The icon stays while the server is running. Double-click it, or choose **Open settings**, to open settings again. The right-click menu can also copy the Tailscale or LAN address, start, stop, or restart the server, open the logs folder, turn **Start with Windows** on or off, or quit. A short notice appears when the server comes up. If the server stops on its own, the icon changes so you can see it. Other devices still open the file browser at the Tailscale or LAN address.

The password lock is unchanged: drives stay behind that login. Uninstall stops the tray icon and the server, removes the program, shortcuts, and the startup entry, and asks before deleting the saved password.

Tailscale and public addresses use the same plain-HTTP sign-in rules Pinokio already uses, so the login form works from a tailnet address. That does not turn the lock off.

If Drivebay is already installed, the .exe runs an update. It stops Drivebay, replaces the program files, and keeps the account, password, mode, and settings. A saved port outside 42000-42999 stays. A saved port in that range moves to 8765, or the next free port outside that range. Setup prints the new address and updates the firewall rule and the shortcut. It does not ask for the port, username, password, or Tailscale. It starts Drivebay again, checks `/api/health`, and the finish page says `Drivebay updated to 3.36`.

Your username and password are stored in a `data` folder next to the app. **Update does not delete them.**

## Install from the command line (Windows)

No installer and no Pinokio. Paste this in PowerShell:

```
irm https://raw.githubusercontent.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/main/install.ps1 | iex
```

Or in CMD:

```
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/main/install.ps1 | iex"
```

The script downloads the latest GitHub release server archive (`drivebay-server-win-x64.zip`) and installs that build. If the latest release has no server archive, it downloads `main`. Running `install.ps1` from a checkout uses the files in that checkout. If Node.js 22 is missing, it downloads a portable Node into `%LOCALAPPDATA%\Drivebay` (no administrator account required).

A first-time install asks for the same choices as the .exe installer:

1. **Mode.** Tailscale (Recommended) is the default. Press Enter to keep it. Nothing is opened to the internet, and only your own signed-in devices can reach Drivebay. Tailscale + Local (Both) keeps Tailscale and adds a public path that starts off. No Tailscale (Regular mode) exposes the port publicly. For a script, set `DRIVEBAY_SETUP_MODE` to `tailscale`, `both`, or `regular`.
2. **Tailscale** (Tailscale or Both). It asks **Do you already have Tailscale?** and preselects Yes when `Tailscale.exe` is already installed. Yes goes straight to the port, username, and password. No offers: download and install Tailscale (the official quiet installer), then sign in or create a free account, or Skip. Skip prints that you can install Tailscale and set it up later, then continues. For a script, set `DRIVEBAY_TAILSCALE` to `have`, `install`, or `skip`.
3. **Port.** Required. A free port from 1024 to 65535. The suggested port is 8765. If that port is already in use, setup names the program and asks for another port. Pinokio's Caddy takes ports from 42000 to 42999, so the suggested port stays outside that range.
4. **Router** (Regular and Both). After the port, setup prints this PC's local IP and, when it can, the public IP. Log in to the router (usually `http://192.168.0.1` or `http://192.168.1.1`), forward TCP that port to the local IP, and give this PC a reserved or static DHCP address. From outside the network, open `http://<public-ip>:<port>/`. Some ISPs use CGNAT and block this. Tailscale is the easy fallback. Use a strong password. Type YES to continue. Tailscale-only skips this page. The same steps are on this PC's settings page while Regular or Both mode is on. In Both, public access starts off.
5. **Password.** The only username and password (at least 8 characters). The password is saved as UTF-8 in `%LOCALAPPDATA%\Drivebay\pending-account.json`, the same file the .exe installer writes. The first launch signs in with that account. It does not ask you to create it again.

If Drivebay is already installed (`config.json`, or a saved port plus the account or `data` folder), the script runs an update. It stops Drivebay, replaces the program files, and keeps the account, password, mode, and settings. A saved port outside 42000-42999 stays. A saved port in that range moves to 8765, or the next free port outside that range. Setup prints the new address and updates the firewall rule and the shortcut. It does not ask for a port, username, password, or Tailscale. A port check during the update ignores this Drivebay if it still holds its own port. After restart it checks `/api/health`. The last line is `Drivebay updated to 3.36`. Once a release is published, an older Drivebay must update. The check reads `version-manifest.json` on the latest GitHub release. If that file cannot be read, Drivebay keeps running.

To wipe the saved account and run a first-time install, set `DRIVEBAY_UNINSTALL_FORCE=1` before the install command.

A Start menu shortcut named **Drivebay** starts it. On this PC that opens the settings page, and the tray icon stays. The file browser is not opened on this PC.

## Uninstall from the command line (Windows)

Paste this in PowerShell:

```
irm https://raw.githubusercontent.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/main/uninstall.ps1 | iex
```

Or in CMD:

```
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/main/uninstall.ps1 | iex"
```

It stops node on the Drivebay port, `DrivebayTray.exe`, and the launcher. It removes the startup Run entry, scheduled tasks, Start menu and desktop shortcuts, and the program files under `%LOCALAPPDATA%\Drivebay` and `%LOCALAPPDATA%\Programs\Drivebay`. Anything already gone is skipped. It asks before deleting the saved password and settings. Type YES to delete them.

For a script, save the file and run one of these:

```
powershell -ExecutionPolicy Bypass -File uninstall.ps1 -KeepData
powershell -ExecutionPolicy Bypass -File uninstall.ps1 -Force
```

`-KeepData` leaves the account and settings. `-Force` deletes them without asking. With `irm | iex`, set `DRIVEBAY_UNINSTALL_KEEP_DATA=1` or `DRIVEBAY_UNINSTALL_FORCE=1` before the command. The last line is `Drivebay is uninstalled.`

Search: type in the search box and press Enter (or Ctrl/Cmd+K). It looks through the current folder and its subfolders. Hidden folders follow the eye toggle.

## Install on macOS or Linux

Each release has an unsigned tarball per platform: `drivebay-server-darwin-arm64.tar.gz` (Apple silicon Mac), `drivebay-server-darwin-x64.tar.gz` (Intel Mac), `drivebay-server-linux-x64.tar.gz`, and `drivebay-server-linux-arm64.tar.gz`. Node is included.

1. Download the tarball for this computer from [GitHub Releases](https://github.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/releases/latest).
2. Unpack it: `mkdir drivebay && tar -xzf drivebay-server-*.tar.gz -C drivebay && cd drivebay`
3. macOS only: the build is unsigned, so clear the download quarantine once: `xattr -dr com.apple.quarantine .`
4. Run `bash unix/install.sh`. It asks for Tailscale, Tailscale + Local, or Regular mode, a port (8765), a username, and a password of at least 8 characters. Linux starts a systemd user service. macOS starts a LaunchAgent. Both start Drivebay at login. Without a login item it starts Drivebay in the background.
5. Open `http://127.0.0.1:<port>/settings` on this computer.

To update, run `bash unix/install.sh` from a newer tarball. It keeps the account, port, and settings and ends with `Drivebay updated to <version>`. Stop with `~/.local/bin/drivebay --stop`.

`bash ~/.local/share/drivebay/program/uninstall.sh` removes the program, the command, and the login item. It asks before deleting the account. `DRIVEBAY_UNINSTALL_KEEP_DATA=1` keeps the account. `DRIVEBAY_UNINSTALL_FORCE=1` deletes it without asking.

Signing and notarization stay off until `DRIVEBAY_CODESIGN_IDENTITY` and `DRIVEBAY_NOTARY_PROFILE` are set. `unix/sign-mac.sh` prints those steps and does not embed a key.

## Mount a phone as a drive

The Android app can share folders you pick as a WebDAV drive on Tailscale or the local network. It is off until you turn it on. On Windows, the tray menu has **Connect my phone…**. Settings on this PC has the same form. See [docs/phone-as-drive.md](docs/phone-as-drive.md) for Windows, macOS, and Linux.

## After it is running

- Browse folders, preview images and text, upload, new folder, rename, delete.
- Click **Lock** when you walk away.
- Open **Settings** for password, port, version, and feature requests.
- Use **Update** in Pinokio if this repo changes.

## Safety

Treat the password like a house key. Do not share the Pinokio link and the password together. The first person to open a fresh install owns the lock — make sure that person is you.

## How-to guide

The same guide is on this PC's settings page. Each part is collapsed until you open it.

### Connect the Android app

Install the Android APK from the link on this page. The Google Play button stays hidden until a store link is set. A later Android build can show Public access On or Off. This page shows that state today.

Tailscale is the safer way to connect the phone. Install Tailscale on the phone and sign in to the same Tailscale account as this PC. In the app, open http://<this-PC-tailscale-name>:<port>/ and sign in with the Drivebay username and password. You do not forward that port on the router.

Regular mode, or Both with public access on, uses the local network or the public internet. On the same Wi-Fi, open http://<this PC local IP>:<port>/. From outside the network, open http://<public-ip>:<port>/ after the router forwards that port. In Both mode, turn Public access on first. While it is off, the phone sees a refusal page and no sign-in form.

### Install Tailscale and sign in

On this PC, setup can download the official Tailscale installer for Windows from pkgs.tailscale.com. Sign in, or create a free Tailscale account. You can also skip that step and install Tailscale later from https://tailscale.com/download/windows.

1. On the PC, open Tailscale and click Sign in, or create a free account if you do not have one.
2. Finish sign-in in the browser. Wait until this PC shows as connected.
3. On the phone, install Tailscale and sign in to that same account.
4. On the phone, open http://<this-PC-tailscale-name>:<port>/ and sign in to Drivebay.

### The three ways other devices reach this PC

Tailscale (Recommended) is the safer choice and the default. Nothing is opened to the internet. Only your own signed-in devices can reach Drivebay. You do not forward the port on the router.

Tailscale + Local (Both) keeps Tailscale, and adds a public path you can turn on later. That path starts off. Drivebay still answers on Tailscale while public access is off.

No Tailscale (Regular mode) exposes the port publicly. Other devices reach this PC only after the router forwards the port. Use a strong password. It is the lock for every drive on this PC.

### Turn public access on and off

Public access is only for Tailscale + Local (Both). Settings shows Public access: On or Public access: Off. A new install starts off.

Only this PC can turn it on or off. A phone, Tailscale, or another computer cannot change it. The other server settings stay on this PC only.

While public access is off, a browser that is not on this PC and not on Tailscale gets a refusal page and no sign-in form. While it is on, that browser gets the normal sign-in. Tailscale keeps working either way.

When you turn it on, you can leave it on, or turn it off automatically after 1 hour, 4 hours, or 24 hours. The page shows the time it will turn off.

### Forward the port on your router

Regular mode and Both mode use these steps. Tailscale-only skips them. In Both, public access starts off, so the forward matters when you turn that path on.

1. Find this PC's local IP. This page prints it when Regular or Both mode is on. If it is missing, run ipconfig and use the IPv4 address.
2. Log in to the router. The page is usually http://192.168.0.1 or http://192.168.1.1.
3. Add a port forward for TCP the Drivebay port to that local IP.
4. Give this PC a reserved or static IP in the router's DHCP settings so the address does not change.
5. Find the public IP. From outside the network, open http://<public-ip>:<port>/.
6. If Windows Firewall asks, allow Drivebay or that TCP port as well.

Some ISPs use CGNAT and block this. Tailscale is the easy fallback.

### What each server lock option does

Server lock is changed on this PC only. A phone, another computer, and the Android app can read the lock and cannot change it.

1. Port from this page: when this is off, Settings cannot save a new port.
2. Delete: when this is off, files cannot be deleted.
3. Rename: when this is off, files and folders cannot be renamed.
4. New folder: when this is off, new folders cannot be created.
5. Upload: when this is off, uploads are blocked.
6. Max upload (MB): the largest upload, from 1 to 8192 MB.
7. All drives: every drive on this PC can be opened. Choose drives limits the list to the drives and folders you pick.

Save server lock. Most changes take effect immediately. If the page asks you to restart, use Restart Drivebay.

### Change the port and restart

Pick Static to keep the same port every start, or Random to get a new port each start. A static port must be a free number from 1024 to 65535. The suggested port is 8765. Ports from 42000 to 42999 are left for Pinokio's Caddy.

Save the port, then stop Drivebay and start it again. In Pinokio, stop it there and click Start. From the tray icon, restart the server. If you use Regular or Both, update the router forward to the new port.

### Update Drivebay and uninstall

To update from this PC, use Update when the page says Update available, or run the install command again. Drivebay checks the latest GitHub release at most once every 12 hours, and Settings has Check for updates. On Windows, Update downloads the installer and runs it silently, then restarts the server. On macOS and Linux, Update downloads the tarball, replaces the program files, and restarts the service. The account, password, mode, and settings stay. A saved port outside 42000-42999 stays. A saved port in that range moves to 8765, or the next free port outside that range. Setup prints the new address and updates the firewall rule and the shortcut. It does not ask for a port, username, password, or Tailscale. The last line is Drivebay updated to 3.36.4. A version below the published minimum must update. If the check cannot reach GitHub, Drivebay keeps running.

Paste this in PowerShell:

```
irm https://raw.githubusercontent.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/main/install.ps1 | iex
```

The .exe installer updates the same way when you run it again, including a silent update. The finish page says Drivebay updated to 3.36.4. In Pinokio, use Update.

To uninstall, paste this in PowerShell:

```
irm https://raw.githubusercontent.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/main/uninstall.ps1 | iex
```

Uninstall stops Drivebay, removes shortcuts and the startup entry, and deletes the program files. It asks before deleting the saved password and settings. Type YES to delete them. Set DRIVEBAY_UNINSTALL_KEEP_DATA=1 to keep them, or DRIVEBAY_UNINSTALL_FORCE=1 to delete them without asking. The last line is Drivebay is uninstalled. If a Pinokio copy is still running, uninstall says so and leaves that copy running.

### Reset a forgotten password

A forgotten password can only be reset on this PC. A phone, a browser, or another computer cannot reset it. Settings, drives, and API tokens stay. Every signed-in device has to sign in again.

1. On this PC, right-click the Drivebay icon in the notification area.
2. Choose Reset password.
3. Type the new password twice. It is masked, and it is not printed or saved in a log.
4. Sign in with the new password.

On this PC you can also open PowerShell and run drivebay reset-password. It asks for the new password twice. Paste this:

```
irm https://raw.githubusercontent.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/main/reset-password.ps1 | iex
```

### Common problems

Port already in use. Setup names the program that holds the port. Pinokio's Caddy (z:\pinokio\bin\miniforge\Library\bin\caddy.exe) takes ports from 42000 to 42999 while Pinokio is running, even when Drivebay is not installed in Pinokio. Setup asks for a different port outside that range. The suggested port is 8765. The message can say That is a Pinokio copy of Drivebay. An update ignores this Drivebay when it still holds its own port. A saved port from 42000 to 42999 moves automatically. Any other saved port stays.

Cannot reach this PC. On Tailscale, both devices must be signed in to the same account, and the phone must use http://<this-PC-tailscale-name>:<port>/. On Regular, the same Wi-Fi uses this PC's local IP, and outside the network uses the public IP after the router forward. Allow the port in Windows Firewall if Windows asks. In Both mode, a public or LAN address stays on the refusal page until public access is on.

Some ISPs use CGNAT and block a router forward, so http://<public-ip>:<port>/ never opens. Tailscale is the easy fallback, because nothing is opened to the internet.

## API tokens

On this PC, Settings can create, list, and revoke a read-only token. The secret is shown once, as `db_` plus 32 random bytes, and Drivebay stores only a hash. Each token has a name, a read scope, an optional folder allowlist, an expiry, and a last-used time. The read scope is roots, list, stat, search, download with Range, and thumbnails.

Clients send `Authorization: Bearer` to these paths:

- `GET /api/v1/roots`
- `GET /api/v1/list?path=`
- `GET /api/v1/stat?path=`
- `GET /api/v1/search?path=&q=`
- `GET /api/v1/download?path=` (supports `Range: bytes=`)
- `GET /api/v1/thumb?path=`

A path has to stay inside the drives this PC already allows, then inside the token's folders when those are set. A symlink that points outside is refused. Calls are rate limited. The settings page on this PC shows an audit log. Creating, listing, and revoking a token stays on this PC.

This PC can choose **Allow write for** 15 minutes, 1 hour, or 4 hours. During that window the token can use:

- `PUT /api/v1/upload?path=` (add `&overwrite=1` to replace a file)
- `POST /api/v1/mkdir` with `{ "path" }`
- `POST /api/v1/rename` with `{ "path", "name" }`
- `POST /api/v1/delete` with `{ "path" }`

When the window ends, those calls are refused and nothing is written. They also follow the server lock on this PC. A symlink is not followed into a write, and deleting a symlink removes the link.

A write outside the window is not performed. Drivebay returns 403 with `approval_request_id` and shows a yes or no card on this PC, with a live badge. Yes allows that one action. The card can also open a 15 minute, 1 hour, or 4 hour window. The client polls `GET /api/v1/approvals/<id>` or retries with header `X-Drivebay-Approval` (or `?approval=`). A pending request expires after about 10 minutes. The server lock is not bypassed: a locked action is 403 with no approval id. A later Android build can show the same card.

## OpenClaw skill

The folder `skills/drivebay` is a Node.js skill. It installs no packages. Set `DRIVEBAY_URL` to this PC and `DRIVEBAY_TOKEN` to a token from the settings page. The secret is shown once, and Drivebay stores only a hash.

From that folder, run `node scripts/drivebay.js` with `roots`, `ls`, `stat`, `find`, `get`, `put`, `mkdir`, `mv`, or `rm`. The script's only network call is to `DRIVEBAY_URL`. It does not print the token. It does not overwrite a remote file or a local download unless `--yes` is passed. A download larger than `DRIVEBAY_GET_CONFIRM_BYTES` (default 20 MB) also waits for `--yes`. When there is no terminal, those commands stop unless `--yes` was passed.

`put`, `mkdir`, `mv`, and `rm` do nothing until this PC allows them. The script prints `Waiting for approval on Drivebay` and polls `GET /api/v1/approvals/<id>`.

Publish the skill from the repository root after `clawhub login`:

```
clawhub skill publish ./skills/drivebay --slug drivebay --name "Drivebay" --version 1.0.0
```

Do not include the token in that publish.

## Support Drivebay

The settings page shows a **Donate** button. It opens a small menu. Each choice opens in the browser. The URLs live in `app/src/lib/donate.mjs`.

- `DONATE_GITHUB_SPONSORS_URL` for GitHub Sponsors. It is blank, so that choice stays out of the menu.
- `DONATE_PAYPAL_URL` for PayPal: https://www.paypal.com/donate/?business=AAGD9Q6BU4WCE&currency_code=USD&item_name=Support%20Drivebay%20-%20Mesa%20and%20Moon%20Studios
- `DONATE_KOFI_URL` for Ko-fi: https://ko-fi.com/mesaandmoonstudios

A blank constant leaves that choice out of the menu. With every constant blank, the button stays off the page.

`.github/FUNDING.yml` lists the PayPal link under `custom` and Ko-fi as `ko_fi: mesaandmoonstudios`. `github: lordstryfe` stays commented until GitHub Sponsors is approved.

## Changelog

### 3.36.4
- Desktop servers check the latest GitHub release at most once every 12 hours. Settings has Check for updates. The page says Update available when a newer release is published.
- On Windows, Update downloads `Drivebay-Setup-3.36.4.exe` and runs it silently. The installer keeps the account, port, and settings, then restarts the server. The tray shows Update available and a notification. A version below `minimum` in version-manifest.json still must update. If the check cannot reach GitHub, Drivebay keeps running.
- On macOS and Linux, Update downloads the matching `drivebay-server-*.tar.gz`, replaces the program files, and restarts the service. Config stays.
- The Windows installer and the server report 3.36.4. `/api/health` returns `version` 3.36.4. Android stays 3.34.5 (versionCode 33405).
- Phone as a drive can pair more than one PC. The phone asks for an owner password (stored as a hash) before sharing is turned on or a PC is paired or revoked. Each PC gets its own 6-digit code and token. Several PCs can use the share at the same time. Revoke drops that PC immediately. A phone that already had one token keeps it as the first paired PC. The PC stores that phone's token for itself and still reconnects with the saved pairing.

### 3.36.3
- Android: the green "This phone is shared as a drive" banner sits above the file browser, under the status bar, so the toolbar and the first file row are visible and the list scrolls.
- Android: Open on a finished download opens the file in another app. The file is a FileProvider link with read permission. If no app can open it, a toast says so.
- Phone as a drive reconnects after the phone app or the PC tray is closed or restarted. The phone keeps the token hash and folders and starts the share again (including after reboot). The PC keeps the token in Credential Manager and the last address, retries with backoff, and looks up the phone's current Tailscale or LAN address. The banner and the tray say Reconnecting... or Connected. A new token is only needed when the phone refuses the saved one.
- Android app 3.34.5 (versionCode 33405). This includes the 3.34.1 crash fix, the 3.34.2 6-digit code, the 3.34.3 whole-phone storage option, and the 3.34.4 banner, reconnect, and Open fixes. The Windows installer and the server report 3.36.3. `/api/health` returns `version` 3.36.3.
- Android: Update available. A Play install checks Google Play on launch and when you return to the app, at most once every 12 hours. Update starts a flexible download, or an immediate one when the Play release priority is 4 or 5. When the download finishes, the app asks you to restart. An install that did not come from Play checks the latest GitHub release for an APK with a higher versionCode, using version-manifest.json when that release includes Android version fields, then downloads the APK and opens the package installer. Settings has Check for updates, which checks immediately.

### 3.36.2
- macOS and Linux installers ship on the release: `drivebay-server-linux-x64.tar.gz`, `drivebay-server-linux-arm64.tar.gz`, `drivebay-server-darwin-arm64.tar.gz`, `drivebay-server-darwin-x64.tar.gz`, and `version-manifest.json`. Unpack and run `bash unix/install.sh`. The Mac build is unsigned.
- `unix/install.sh` reads x.y.z versions, stops a running copy before an update, records the new version, returns after setup instead of holding the terminal, does not start a second copy next to the login item, and does not open a browser without a desktop session. `drivebay --stop` and `unix/uninstall.sh` now also end a server that closed its port on SIGTERM but kept running.
- Desktop update checks read `version-manifest.json` from the latest GitHub release. A version below `minimum` must update. A missing file or a failed request leaves Drivebay running. The Windows tray adds Check for updates.
- The Windows installer and the server report 3.36.2. `/api/health` returns `version` 3.36.2. Windows behavior is the same as 3.36.1.

### 3.36.1
- New in the Windows tray: Connect my phone. Type the 6-digit code from the Android app once; Drivebay finds the phone over Tailscale (online Android peers answering WebDAV on port 8780), checks the code with one request, keeps it only in Windows Credential Manager, and maps the phone with WNetAddConnection2 as "Drivebay Phone" on P: or the next free letter. It rechecks every 30 seconds (backing off to 5 minutes while the phone is away) and reconnects. A refused code stops all retries, removes the mapping and saved code, and asks for a new code. "Unmount and forget phone" removes the drive, label, and saved code. Advanced lets you set the address and drive letter. Logs go to `%LOCALAPPDATA%\Drivebay\phone-mount.log` with secrets masked.
- The installer stops every running Drivebay tray, launcher, and server for the user, including older copies in `%LOCALAPPDATA%\Drivebay`, before it chooses a port, and keeps a saved port. An old copy left running could make setup move to another port.
- The Windows installer and the server report 3.36.1. `/api/health` returns `version` 3.36.1. The release files are `Drivebay-Setup-3.36.1.exe` and `drivebay-server-win-x64.zip`.

### 3.36 (not released; folded into 3.36.2)
- The Windows installer and the server report 3.36. `/api/health` returns version 3.36. Download [Drivebay-Setup-3.36.exe](https://github.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/releases/latest/download/Drivebay-Setup-3.36.exe) after that release is published.
- macOS (arm64 and x64) and Linux (x64 and arm64) tarballs are built in GitHub Actions. `unix/install.sh` asks for the mode, port, and password, starts Drivebay at login, and `unix/uninstall.sh` removes it. The Mac build is unsigned. `unix/sign-mac.sh` is the later signing hook.
- A published release can require an update. Drivebay reads `version-manifest.json` on the latest GitHub release. A version below `minimum` must update. If GitHub cannot be read, Drivebay keeps running.
- Android app 3.34.0 (versionCode 33400, `com.mesaandmoon.drivebay`) includes the 3.33.4 Play update gate, a phone-to-PC upload fix, a paused-downloads list, edge-to-edge insets, and an optional phone-as-drive WebDAV share. This release does not attach an APK.

### 3.35
- The web UI no longer loads anything from other sites. Fonts (Instrument Sans and IBM Plex Mono) ship with Drivebay, and the Google Fonts stylesheet, the og.grok.me preview image, and the injected grok.com banner script are gone.
- The Windows installer and the server report 3.35. `/api/health` returns version 3.35. Download [Drivebay-Setup-3.35.exe](https://github.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/releases/latest/download/Drivebay-Setup-3.35.exe).
- The Android app is unchanged (3.33.0).

### 3.34
- Fix: opening a folder or file no longer jumps back to the start folder a few seconds later. The browser re-ran its start-folder load on every render, which also flooded the server with listing requests. It now runs only when the signed-in account changes.
- The Windows installer and the server report 3.34. `/api/health` returns version 3.34. Download [Drivebay-Setup-3.34.exe](https://github.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/releases/latest/download/Drivebay-Setup-3.34.exe).
- The Android app is unchanged (3.33.0).

### 3.33
- The Windows installer and the server report 3.33. `/api/health` returns version 3.33. Download [Drivebay-Setup-3.33.exe](https://github.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/releases/latest/download/Drivebay-Setup-3.33.exe).
- Server settings stay on this PC. A phone or the Android app does not show drives, port, mode, API tokens, donate, password, updates, or Tailscale setup. Admin setting calls from anywhere except this PC return 403.
- Other devices can delete, and they can upload or rename, until this PC turns those switches off. Both start on. This PC can always do those actions.
- The Android app is 3.33.0 (versionCode 33). Its Settings screen is the server address and Wi-Fi downloads. It does not open the PC settings page.

### 3.32
- The Windows installer and the server report 3.32. `/api/health` returns version 3.32. Download [Drivebay-Setup-3.32.exe](https://github.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/releases/latest/download/Drivebay-Setup-3.32.exe).
- A forgotten password can be reset on this PC only. The tray menu has Reset password, and PowerShell can run `drivebay reset-password`. The login page explains that. There is no remote reset. The new password replaces the saved account hash and signs every device out. Settings, drives, and API tokens stay.

### 3.31
- The Windows installer and the server report 3.31. `/api/health` returns version 3.31. Download [Drivebay-Setup-3.31.exe](https://github.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/releases/latest/download/Drivebay-Setup-3.31.exe). The command-line install uses drivebay-server-win-x64.zip from that release.
- The Android app 3.30.0 is in `android/`. Phone downloads save to Downloads/Drivebay and can resume. `GET` and `HEAD /api/download` support Range.

### 3.30
- The repository is https://github.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio. Install, uninstall, update checks, and the settings feature-request link use that path. The Windows download is [Drivebay-Setup-3.30.exe](https://github.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/releases/latest/download/Drivebay-Setup-3.30.exe).

### 3.29
- The Donate menu includes Ko-fi: https://ko-fi.com/mesaandmoonstudios `.github/FUNDING.yml` lists `ko_fi: mesaandmoonstudios`. PayPal stays in the menu. GitHub Sponsors stays blank, so that choice stays out of the menu.

### 3.28
- The Donate menu includes PayPal: https://www.paypal.com/donate/?business=AAGD9Q6BU4WCE&currency_code=USD&item_name=Support%20Drivebay%20-%20Mesa%20and%20Moon%20Studios `.github/FUNDING.yml` lists that same link under `custom`. GitHub Sponsors and Ko-fi stay blank, so those choices stay out of the menu.

### 3.27
- Settings has a Donate button. The menu lists GitHub Sponsors, PayPal, and Ko-fi. The URLs live in `app/src/lib/donate.mjs`. A blank URL hides that choice, and the button stays off the page while every URL is blank. `.github/FUNDING.yml` keeps `github: lordstryfe` commented until GitHub Sponsors is approved.

### 3.25
- `skills/drivebay` is an OpenClaw skill. It needs Node.js, `DRIVEBAY_URL`, and `DRIVEBAY_TOKEN`. Commands are `roots`, `ls`, `stat`, `find`, `get`, `put`, `mkdir`, `mv`, and `rm`. The script talks only to `DRIVEBAY_URL`, does not print the token, and does not overwrite a file or download a large file unless `--yes` is passed.
- A write outside the open window prints `Waiting for approval on Drivebay` and polls `GET /api/v1/approvals/<id>`. Publish from the repository root with `clawhub skill publish ./skills/drivebay --slug drivebay --name "Drivebay" --version 1.0.0` after `clawhub login`. Do not include the token.

### 3.24
- A write outside the open window is not performed. Drivebay returns 403 with `approval_request_id` and a pending request (token name, action, path, size). This PC shows a yes or no card and a live badge.
- Yes allows that single action. The card can also open a write window of 15 minutes, 1 hour, or 4 hours. The client polls `GET /api/v1/approvals/<id>` or retries with `X-Drivebay-Approval`. Pending requests expire after about 10 minutes. The server lock still refuses the action and does not create an approval. A later Android build can show the same card.

### 3.23
- A token can be given **Allow write for** 15 minutes, 1 hour, or 4 hours from this PC or a signed-in Tailscale device. During that window, `PUT /api/v1/upload`, `POST /api/v1/mkdir`, `POST /api/v1/rename`, and `POST /api/v1/delete` accept the bearer token. When the window ends, those calls are refused and nothing is written.
- Writes still follow the server lock on this PC. A symlink is not followed into a write. Deleting a symlink removes the link.

### 3.22
- Settings on this PC can create, list, and revoke a read-only API token. The secret is shown once (`db_` plus 32 random bytes) and only a hash is stored. Each token has a name, the read scope (roots, list, stat, search, download with Range, thumbnails), an optional folder allowlist, an expiry, and a last-used time.
- Clients send `Authorization: Bearer` to `GET /api/v1/roots`, `list`, `stat`, `search`, `download`, and `thumb`. Paths stay inside the allowed folders, including through a symlink. Calls are rate limited, and this PC's settings page shows an audit log.

### 3.21
- Settings on this PC has a How-to guide with the same sections as the [How-to guide](#how-to-guide) above. Each part is collapsed until you open it.
- The install mode choice recommends Tailscale and selects it by default. Tailscale keeps the port off the public internet. Regular mode exposes it. Tailscale + Local (Both) keeps Tailscale and adds a public path that starts off. `DRIVEBAY_SETUP_MODE` can be `tailscale`, `both`, or `regular`.
- In Both mode, settings shows **Public access: On** or **Off**. This PC and a signed-in Tailscale device can change it. A public or LAN address cannot. Off shows a refusal page with no sign-in form. On shows the normal sign-in. An optional timer turns it off after 1 hour, 4 hours, or 24 hours. A later Android build can show the same state.
- No Tailscale (Regular mode) stays available. After the port, setup and this PC's settings page walk through the router forward: local IP, router login, TCP forward, a reserved DHCP address, and `http://<public-ip>:<port>/` from outside. CGNAT can block that path. Tailscale is the easy fallback. Use a strong password.
- Installing again, from `install.ps1` or the .exe, updates Drivebay. It keeps the account, password, port, mode, and settings, restarts, checks `/api/health`, and prints `Drivebay updated to 3.21`. A first-time install is the only path that asks for the port, username, password, and Tailscale.
- A first-time Tailscale install asks whether Tailscale is already on this PC. Yes continues. No can download the official Tailscale installer, then walks through sign-in or a free account, or skip Tailscale for later. `DRIVEBAY_TAILSCALE` can be `have`, `install`, or `skip`.
- Setup refuses a port that is already in use, including Pinokio's Caddy, and names the program that holds it. It prints the ready line only after this Drivebay server answers `/api/health`. Uninstall says when a Pinokio copy is still running.
- Settings includes **Get the Android app**, with a link to the latest APK. The Google Play button stays hidden until `PLAY_STORE_URL` in `app/src/lib/version.ts` is set.
- Command-line Windows install. No installer and no Pinokio. PowerShell: `irm https://raw.githubusercontent.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/main/install.ps1 | iex`
- On this PC, starting Drivebay opens the settings page. It does not open the file browser. The tray icon stays. Other devices still use the Tailscale or LAN address.

### 3.20
- The installer writes the password as UTF-16. An 8-character password is saved and used for login. If saving still fails, setup shows the reason.
- Standalone setup adds a notification-area icon. The Start menu and Start with Windows open that icon instead of a console window. Quit and uninstall stop it.

### 3.19
- Installer text is plain ASCII, so mode choices no longer show a broken em dash.
- The password page accepts two matching passwords and rejects a mismatch, a short password, or an empty one.
- Tailscale mode skips the router port-forward notice. Regular mode still requires it. Both modes still pick a local port.

### 3.18
- Windows installer that does not need Pinokio, Node.js, or git.
- Setup: Tailscale or regular, a free port, router-forward notice for that port, and the account password.
- Optional official Tailscale install, Start menu, desktop shortcut, uninstaller, and start with Windows.

Versions 3.15–3.17 are in [CHANGELOG.md](CHANGELOG.md).

### 3.14
- Search walks **subfolders**.
- Hidden folders (names starting with `.`) are included when the eye is on.
- Toggling the eye re-runs the current search.

### 3.13
- Opens on **Home** instead of Workspace.
- Settings shows the version number.
- **Request a feature** in Settings opens a GitHub issue.

### 3.12
- Home page no longer loads the big file-browser module on the server (fixes Windows 500).
- **Update** now force-resets to GitHub `main` so new code actually arrives.

### 3.11
- Removed leftover file-list code that crashed the home page (500).

### 3.10
- Fixed a typo in `vite.config.ts` that blocked **Start**.

### 3.9
- Stopped a Windows database crash from showing a JSON 500 page.

### 3.8
- **Search this folder** (Enter or Ctrl/Cmd+K).

### 3.7
- **Settings** page (password + port).
- Login lock stored in a `data` folder so **Update does not wipe it**.

### 3.6
- Install / Set port asks **Random** or **Static**.

### 3.5
- Installer can pick a **static port** for router forwarding.

### 3.4
- Login works from a public / Tailscale / phone address (invalid origin fix).

### 3.3 and earlier
- Pinokio install package, X: and Z: drives, password lock, file browser.

## From source

Pinokio install, start, and set-port are unchanged. To work on the app itself:

```sh
cd app
npm install
npm run dev
```
