# Drivebay

Password-locked file browser for every drive on this machine. Built to run inside [Pinokio](https://pinokio.computer).

**Install this URL in Pinokio:**

```
https://github.com/lordstryfe/drivebay-pinokio
```

Current version: **3.25** — see [Changelog](#changelog) below.

## Install in Pinokio (do this)

1. Delete any old Drivebay folders first. In File Explorer delete these if they exist:

   - `Z:\pinokio\api\drivebay.git`
   - `Z:\pinokio\api\drivebay`

2. Open **Pinokio**.
3. Go to **Discover** (or **Download from URL**).
4. Paste `https://github.com/lordstryfe/drivebay-pinokio` and download.
5. Click **Install**. Choose **Static** (you pick the port) or **Random** (new port each Start).
6. If you chose Static, forward **that same port** on your router.
7. Click **Start**. On this PC, Drivebay opens the settings page. It does not open the file browser. Other devices use the address Pinokio shows.
8. The first visit creates the **only** username and password. Pick something strong — Pinokio is already visible online, and this app can see every file on the machine.
9. After that, anyone who opens it can only unlock. Nobody else can sign up.
10. In the sidebar, open **X:**, **Z:**, and any other drives you want.

Change the port later with **Set port** or the in-app **Settings** page, then Start again.

## Install without Pinokio

Download **Drivebay-Setup-3.25.exe** from [GitHub Releases](https://github.com/lordstryfe/drivebay-pinokio/releases). You do not need Node.js, git, or Pinokio. The installer includes the server and the runtime that runs it, and it starts a production build.

Push a version tag such as `v3.25` to publish that file on the release. Pull requests also upload the installer as a build artifact.

The setup screens are:

1. **Welcome.** The runtime is included.
2. **Folder.** Where to put the program. This is a per-user install.
3. **Mode.** **Tailscale (Recommended)** is the default. Nothing is opened to the internet, and only your own signed-in devices can reach Drivebay. **Tailscale + Local (Both)** keeps Tailscale and adds a public path that starts off. **No Tailscale (Regular mode)** exposes the port publicly and needs a router port forward.
4. **Tailscale** (Tailscale or Both). The page asks **Do you already have Tailscale?** and selects Yes when Tailscale is already installed. Yes goes on to the port, username, and password. No offers two choices: download and install Tailscale for Windows from the official installer (quiet MSI from `pkgs.tailscale.com`), then sign in or create a free Tailscale account, or **Skip**. Skip says you can install Tailscale and set it up later, then continues.
5. **Port.** Required in every mode. A free port from 1024 to 65535. The suggested port is 42013. This page runs on a first-time install.
6. **Router** (Regular and Both). After the port is chosen, setup prints this PC's local IP, asks you to log in to the router (usually `http://192.168.0.1` or `http://192.168.1.1`), forward TCP **that port** to the local IP, and reserve that IP in DHCP. It prints the public IP when it can, and tells you to open `http://<public-ip>:<port>/` from outside the network. Some ISPs use CGNAT and block this. Tailscale is the easy fallback. Use a strong password. You must check the box to continue. Tailscale-only skips this page. Allow the same port in Windows Firewall if Windows asks. The same steps stay on this PC's settings page while Regular or Both mode is on. In Both, **Public access** starts **Off**. This PC and a signed-in Tailscale device can turn it On, with an optional timer of 1 hour, 4 hours, or 24 hours. A public or LAN address cannot change it. While it is Off, those addresses get a refusal page and no sign-in form. The Android app can show this state in a later build.
7. **Password.** The only username and password (at least 8 characters). The first launch asks you to sign in with that account. It does not ask you to create it again. If that account cannot be saved, setup shows the reason and writes the same text to the install log, and the login page then lets you set the lock.
8. **Shortcuts.** Start menu entries (Drivebay, Stop Drivebay, and Uninstall) are always created. They open a notification-area icon, not a console window. Optional desktop shortcut. Optional **Start Drivebay when I sign in to Windows**, which starts that same icon in the background.
9. **Finish.** On this PC, opens the settings page. It does not open the file browser. The icon stays while the server is running. Double-click it, or choose **Open settings**, to open settings again. The right-click menu can also copy the Tailscale or LAN address, start, stop, or restart the server, open the logs folder, turn **Start with Windows** on or off, or quit. A short notice appears when the server comes up. If the server stops on its own, the icon changes so you can see it. Other devices still open the file browser at the Tailscale or LAN address.

The password lock is unchanged: drives stay behind that login. Uninstall stops the tray icon and the server, removes the program, shortcuts, and the startup entry, and asks before deleting the saved password.

Tailscale and public addresses use the same plain-HTTP sign-in rules Pinokio already uses, so the login form works from a tailnet address. That does not turn the lock off.

If Drivebay is already installed, the .exe runs an update. It stops Drivebay, replaces the program files, and keeps the account, password, port, mode, and settings. It does not ask for the port, username, password, or Tailscale. It starts Drivebay again, checks `/api/health`, and the finish page says `Drivebay updated to 3.25`.

Your username and password are stored in a `data` folder next to the app. **Update does not delete them.**

## Install from the command line (Windows)

No installer and no Pinokio. Paste this in PowerShell:

```
irm https://raw.githubusercontent.com/lordstryfe/drivebay-pinokio/main/install.ps1 | iex
```

Or in CMD:

```
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/lordstryfe/drivebay-pinokio/main/install.ps1 | iex"
```

The script downloads the latest GitHub release server archive (`drivebay-server-win-x64.zip`) and installs that build. If the latest release has no server archive, it downloads `main`. Running `install.ps1` from a checkout uses the files in that checkout. If Node.js 22 is missing, it downloads a portable Node into `%LOCALAPPDATA%\Drivebay` (no administrator account required).

A first-time install asks for the same choices as the .exe installer:

1. **Mode.** Tailscale (Recommended) is the default. Press Enter to keep it. Nothing is opened to the internet, and only your own signed-in devices can reach Drivebay. Tailscale + Local (Both) keeps Tailscale and adds a public path that starts off. No Tailscale (Regular mode) exposes the port publicly. For a script, set `DRIVEBAY_SETUP_MODE` to `tailscale`, `both`, or `regular`.
2. **Tailscale** (Tailscale or Both). It asks **Do you already have Tailscale?** and preselects Yes when `Tailscale.exe` is already installed. Yes goes straight to the port, username, and password. No offers: download and install Tailscale (the official quiet installer), then sign in or create a free account, or Skip. Skip prints that you can install Tailscale and set it up later, then continues. For a script, set `DRIVEBAY_TAILSCALE` to `have`, `install`, or `skip`.
3. **Port.** Required. A free port from 1024 to 65535. The suggested port is 42013. If that port is already in use, setup names the program and asks for another port.
4. **Router** (Regular and Both). After the port, setup prints this PC's local IP and, when it can, the public IP. Log in to the router (usually `http://192.168.0.1` or `http://192.168.1.1`), forward TCP that port to the local IP, and give this PC a reserved or static DHCP address. From outside the network, open `http://<public-ip>:<port>/`. Some ISPs use CGNAT and block this. Tailscale is the easy fallback. Use a strong password. Type YES to continue. Tailscale-only skips this page. The same steps are on this PC's settings page while Regular or Both mode is on. In Both, public access starts off.
5. **Password.** The only username and password (at least 8 characters). The password is saved as UTF-8 in `%LOCALAPPDATA%\Drivebay\pending-account.json`, the same file the .exe installer writes. The first launch signs in with that account. It does not ask you to create it again.

If Drivebay is already installed (`config.json`, or a saved port plus the account or `data` folder), the script runs an update. It stops Drivebay, replaces the program files, and keeps the account, password, port, mode, and settings. It does not ask for a port, username, password, or Tailscale. A port check during the update ignores this Drivebay if it still holds its own port. After restart it checks `/api/health`. The last line is `Drivebay updated to 3.25`.

To wipe the saved account and run a first-time install, set `DRIVEBAY_UNINSTALL_FORCE=1` before the install command.

A Start menu shortcut named **Drivebay** starts it. On this PC that opens the settings page, and the tray icon stays. The file browser is not opened on this PC.

## Uninstall from the command line (Windows)

Paste this in PowerShell:

```
irm https://raw.githubusercontent.com/lordstryfe/drivebay-pinokio/main/uninstall.ps1 | iex
```

Or in CMD:

```
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/lordstryfe/drivebay-pinokio/main/uninstall.ps1 | iex"
```

It stops node on the Drivebay port, `DrivebayTray.exe`, and the launcher. It removes the startup Run entry, scheduled tasks, Start menu and desktop shortcuts, and the program files under `%LOCALAPPDATA%\Drivebay` and `%LOCALAPPDATA%\Programs\Drivebay`. Anything already gone is skipped. It asks before deleting the saved password and settings. Type YES to delete them.

For a script, save the file and run one of these:

```
powershell -ExecutionPolicy Bypass -File uninstall.ps1 -KeepData
powershell -ExecutionPolicy Bypass -File uninstall.ps1 -Force
```

`-KeepData` leaves the account and settings. `-Force` deletes them without asking. With `irm | iex`, set `DRIVEBAY_UNINSTALL_KEEP_DATA=1` or `DRIVEBAY_UNINSTALL_FORCE=1` before the command. The last line is `Drivebay is uninstalled.`

Search: type in the search box and press Enter (or Ctrl/Cmd+K). It looks through the current folder and its subfolders. Hidden folders follow the eye toggle.

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

This PC and a signed-in device on Tailscale can turn it on or off. A public or other LAN address cannot change it, even after sign-in. The other server lock settings stay on this PC only.

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

Pick Static to keep the same port every start, or Random to get a new port each start. A static port must be a free number from 1024 to 65535. The suggested port is 42013.

Save the port, then stop Drivebay and start it again. In Pinokio, stop it there and click Start. From the tray icon, restart the server. If you use Regular or Both, update the router forward to the new port.

### Update Drivebay and uninstall

To update, run the install command again. Drivebay stops, the program files are replaced, and the account, password, port, mode, and settings stay. It does not ask for a port, username, password, or Tailscale. The last line is Drivebay updated to 3.25.

Paste this in PowerShell:

```
irm https://raw.githubusercontent.com/lordstryfe/drivebay-pinokio/main/install.ps1 | iex
```

The .exe installer updates the same way when you run it again. The finish page says Drivebay updated to 3.25. In Pinokio, use Update.

To uninstall, paste this in PowerShell:

```
irm https://raw.githubusercontent.com/lordstryfe/drivebay-pinokio/main/uninstall.ps1 | iex
```

Uninstall stops Drivebay, removes shortcuts and the startup entry, and deletes the program files. It asks before deleting the saved password and settings. Type YES to delete them. Set DRIVEBAY_UNINSTALL_KEEP_DATA=1 to keep them, or DRIVEBAY_UNINSTALL_FORCE=1 to delete them without asking. The last line is Drivebay is uninstalled. If a Pinokio copy is still running, uninstall says so and leaves that copy running.

### Common problems

Port already in use. Setup names the program that holds the port, including Pinokio's Caddy, and asks for another port. The message can say That is a Pinokio copy of Drivebay. An update ignores this Drivebay when it still holds its own port. If a different program holds the saved port, the update stops and keeps that port.

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

This PC, or a signed-in Tailscale device, can choose **Allow write for** 15 minutes, 1 hour, or 4 hours. During that window the token can use:

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

## Changelog

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
- Command-line Windows install. No installer and no Pinokio. PowerShell: `irm https://raw.githubusercontent.com/lordstryfe/drivebay-pinokio/main/install.ps1 | iex`
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
