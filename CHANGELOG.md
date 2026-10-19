# Changelog

All user-facing Drivebay versions. Newest first.

## 3.36.2
- macOS and Linux installers ship on the release: `drivebay-server-linux-x64.tar.gz`, `drivebay-server-linux-arm64.tar.gz`, `drivebay-server-darwin-arm64.tar.gz`, `drivebay-server-darwin-x64.tar.gz`, and `version-manifest.json`. Unpack and run `bash unix/install.sh`. The Mac build is unsigned.
- `unix/install.sh` reads x.y.z versions, stops a running copy before an update, records the new version, returns after setup instead of holding the terminal, does not start a second copy next to the login item, and does not open a browser without a desktop session. `drivebay --stop` and `unix/uninstall.sh` now also end a server that closed its port on SIGTERM but kept running.
- Desktop update checks read `version-manifest.json` from the latest GitHub release. A version below `minimum` must update. A missing file or a failed request leaves Drivebay running. The Windows tray adds Check for updates.
- The Windows installer and the server report 3.36.2. `/api/health` returns `version` 3.36.2. Windows behavior is the same as 3.36.1.

## 3.36.1
- New in the Windows tray: Connect my phone. Type the 6-digit code from the Android app once; Drivebay finds the phone over Tailscale (online Android peers answering WebDAV on port 8780), checks the code with one request, keeps it only in Windows Credential Manager, and maps the phone with WNetAddConnection2 as "Drivebay Phone" on P: or the next free letter. It rechecks every 30 seconds (backing off to 5 minutes while the phone is away) and reconnects. A refused code stops all retries, removes the mapping and saved code, and asks for a new code. "Unmount and forget phone" removes the drive, label, and saved code. Advanced lets you set the address and drive letter. Logs go to `%LOCALAPPDATA%\Drivebay\phone-mount.log` with secrets masked.
- The installer stops every running Drivebay tray, launcher, and server for the user, including older copies in `%LOCALAPPDATA%\Drivebay`, before it chooses a port, and keeps a saved port. An old copy left running could make setup move to another port.
- The Windows installer and the server report 3.36.1. `/api/health` returns `version` 3.36.1. The release files are `Drivebay-Setup-3.36.1.exe` and `drivebay-server-win-x64.zip`.

## 3.36 (not released; folded into 3.36.2)
- The Windows installer and the server report 3.36. `/api/health` returns `version` 3.36. The release files are `Drivebay-Setup-3.36.exe`, `drivebay-server-win-x64.zip`, and the macOS and Linux tarballs `drivebay-server-darwin-arm64.tar.gz`, `drivebay-server-darwin-x64.tar.gz`, `drivebay-server-linux-x64.tar.gz`, and `drivebay-server-linux-arm64.tar.gz`.
- macOS and Linux use `installer/unix/install.sh` for the first-run mode, port, and password, a login item (LaunchAgent or systemd user service), and `uninstall.sh`. The Mac archive is unsigned. `sign-mac.sh` signs only when `DRIVEBAY_CODESIGN_IDENTITY` is set.
- Desktop update checks read `version-manifest.json` from the latest GitHub release. A running version below `minimum` is required to update. A missing file or a failed request leaves Drivebay running.
- Android app 3.34.0 (versionCode 33400). The repo was 3.33.0. Google Play 3.33.4 (versionCode 33304) added the in-app update gate outside this repo; that gate is now in the tree, with the upload fix, the paused-downloads list, edge-to-edge insets, and phone-as-drive. Release signing stays on Aaron's PC. No APK is attached.
- Android app 3.34.1 (versionCode 33401) fixes a crash right after choosing a phone-as-drive folder. 3.34.0 queried the picker's tree URI directly, which Android rejects with `UnsupportedOperationException`. Starting the share is now guarded end to end: the WebDAV server opens folders and binds port 8780 off the main thread, connection handlers can't crash the app, and a failure shows a message and turns sharing off. The last crash or handled error is saved on the phone and can be viewed or shared from Settings › Error log. The service keeps the `specialUse` foreground type.

## 3.35
- The web UI makes no third-party requests. Instrument Sans and IBM Plex Mono are self-hosted under `app/public/fonts/` (SIL OFL), replacing the Google Fonts stylesheet. The `og.grok.me` card meta and the injected `grok.com/grok-app-builder/extensions.js` script are removed.
- The Windows installer and the server report 3.35. `/api/health` returns `version` 3.35. The release files are `Drivebay-Setup-3.35.exe` and `drivebay-server-win-x64.zip`.
- The Android app is unchanged at 3.33.0.

## 3.34
- Fix: opening a folder or file in the file browser no longer jumps back to the start folder a few seconds later. The start-folder load re-ran on every render (it depended on a user object that was rebuilt each render), which also sent a steady stream of listing requests to the server. It now runs only when the signed-in account or the hidden-files toggle changes.
- The Windows installer and the server report 3.34. `/api/health` returns `version` 3.34. The release files are `Drivebay-Setup-3.34.exe` and `drivebay-server-win-x64.zip`.
- The Android app is unchanged at 3.33.0.

## 3.33
- The Windows installer and the server report 3.33. `/api/health` returns `version` 3.33. The release files are `Drivebay-Setup-3.33.exe` and `drivebay-server-win-x64.zip`.
- Server settings stay on the PC that runs Drivebay. The web UI hides drives, port, mode, API tokens, donate, password, updates, and Tailscale or server setup when the request is not loopback or when the page is inside the Android app. Those admin calls return 403 from any other device.
- Settings on this PC has Allow delete from other devices and Allow upload/rename from other devices. Both default to on. Turning one off makes the server reject that action from other devices with 403, and the file browser hides the button. This PC can still delete, upload, and rename. Rename covers moving a file to a new name.
- Android app 3.33.0 (versionCode 33) blocks `/settings` and opens an app settings screen for the server address and Wi-Fi-only downloads. The release does not attach an APK.

## 3.32
- The Windows installer and the server report 3.32. `/api/health` returns `version` 3.32. The release files are `Drivebay-Setup-3.32.exe` and `drivebay-server-win-x64.zip`.
- A forgotten password can be reset on this PC only. Right-click the Drivebay tray icon and choose Reset password, or run `drivebay reset-password` in PowerShell. The new password is typed locally, masked, twice. It is not printed or logged. Drivebay updates the Better Auth credential hash for the saved account and deletes its sessions. Settings, drives, and API tokens stay. The login page has Forgot password? and explains that a phone or another computer cannot reset it.

## 3.31
- The Windows installer and the server report 3.31. `/api/health` returns `version` 3.31. The release files are `Drivebay-Setup-3.31.exe` and `drivebay-server-win-x64.zip`.
- Android app 3.30.0 (versionCode 30) lives in `android/`. A download from the phone saves into Downloads/Drivebay with a progress notification (speed and time left), then offers Open and Share. Large files download in 8 MB ranges, can pause, resume, and cancel, retry with backoff, and continue after the connection drops or the app restarts. Files of 50 MB and up can stay on Wi-Fi. The session cookie from the WebView is sent with each request.
- If Tailscale is not installed, the app offers Download (Play Store) or Skip. The hardware back button moves to the parent folder before it leaves the app. Connecting opens the file browser home. The address hint uses port 8765, and a saved port from 42000–42999 asks before it is kept. 8766 is noted as a common port.
- `GET` and `HEAD /api/download` send `Accept-Ranges: bytes` and an ETag from the file size and mtime. A valid `Range` returns 206 with `Content-Range`. A bad range returns 416. `If-Range` sends the slice only when the ETag or modification time still matches.

## 3.30
- The repository is `https://github.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio`. Install, uninstall, update checks, and the settings feature-request link use that path. The Windows installer is `Drivebay-Setup-3.30.exe`.

## 3.29
- The Donate menu includes Ko-fi: `https://ko-fi.com/mesaandmoonstudios`. `.github/FUNDING.yml` lists `ko_fi: mesaandmoonstudios`. PayPal stays in the menu. GitHub Sponsors stays blank, so that choice stays out of the menu.

## 3.28
- The Donate menu includes PayPal: `https://www.paypal.com/donate/?business=AAGD9Q6BU4WCE&currency_code=USD&item_name=Support%20Drivebay%20-%20Mesa%20and%20Moon%20Studios`. `.github/FUNDING.yml` lists that same link under `custom`. GitHub Sponsors and Ko-fi stay blank, so those choices stay out of the menu.

## 3.27
- Settings has a Donate button. It opens a menu of GitHub Sponsors, PayPal, and Ko-fi. The addresses are `DONATE_GITHUB_SPONSORS_URL`, `DONATE_PAYPAL_URL`, and `DONATE_KOFI_URL` in `app/src/lib/donate.mjs`. A blank address hides that choice. With every address blank, the button stays off the page.
- `.github/FUNDING.yml` keeps those links as comments. `github: lordstryfe` stays commented until GitHub Sponsors is approved.

## 3.26
- The suggested port is 8765. Setup skips 42000-42999, the range Pinokio's Caddy (`z:\pinokio\bin\miniforge\Library\bin\caddy.exe`) claims while Pinokio is running, and picks the next free port outside that range when 8765 is taken.
- An update keeps a saved port outside that range. A saved port from 42000 to 42999 moves automatically. Setup prints the new address and updates the firewall rule and the shortcut.
- When a port is already in use, setup names the program. If it is Pinokio's Caddy, the message says so and asks for a port outside 42000-42999.

## 3.25
- `skills/drivebay` is an OpenClaw skill with `SKILL.md` and `scripts/drivebay.js`. It uses Node.js only, with no packages. It needs `DRIVEBAY_URL` and `DRIVEBAY_TOKEN`. Commands are `roots`, `ls`, `stat`, `find`, `get`, `put`, `mkdir`, `mv`, and `rm`.
- The script's only network call is to `DRIVEBAY_URL`. It does not print the token. It does not overwrite a file, and it does not download a file larger than `DRIVEBAY_GET_CONFIRM_BYTES` (default 20 MB), unless `--yes` is passed. A write outside the open window prints `Waiting for approval on Drivebay` and polls until this PC approves, denies, or the request expires.
- Publish the skill from the repository root after `clawhub login`: `clawhub skill publish ./skills/drivebay --slug drivebay --name "Drivebay" --version 1.0.0`. Do not include the token in that publish.

## 3.24
- If a token writes while its window is closed, Drivebay does not perform the write. It returns 403 with `approval_request_id` and keeps a pending request with the token name, action, path, and size. This PC's settings page shows a yes or no card and a live count of waiting requests.
- Yes grants that one action. The card can also open a write window of 15 minutes, 1 hour, or 4 hours. The client polls `GET /api/v1/approvals/<id>` or sends the id in `X-Drivebay-Approval` or the `approval` query. Pending requests expire after about 10 minutes. A server-lock refusal stays 403 with no approval id. A later Android build can show the same card.

## 3.23
- This PC, or a signed-in Tailscale device, can open a write window on a token for 15 minutes, 1 hour, or 4 hours. During the window, `PUT /api/v1/upload`, `POST /api/v1/mkdir`, `POST /api/v1/rename`, and `POST /api/v1/delete` accept the bearer token. When the window ends, the token is read-only again and a write is not performed.
- Those writes still obey the server lock toggles on this PC. A locked action is refused. Upload will not follow a symlink, and deleting a symlink removes the link rather than the target. A new folder is one level, and the parent has to exist.

## 3.22
- Settings on this PC can create, list, and revoke a read-only API token. The secret is shown once, as `db_` plus 32 random bytes, and the file stores only a SHA-256 hash plus a short prefix. Each token has a name, a read scope (roots, list, stat, search, download with Range, and thumbnails), an optional folder allowlist, an expiry, and a last-used time.
- Clients send `Authorization: Bearer` to `GET /api/v1/roots`, `/api/v1/list`, `/api/v1/stat`, `/api/v1/search`, `/api/v1/download`, and `/api/v1/thumb`. A path is refused when its real path leaves the allowed folders, including through a symlink. Calls are rate limited. This PC's settings page shows an audit log. Creating, listing, and revoking a token stays on this PC.

## 3.21
- Settings on this PC has a How-to guide. Each part is collapsed until you open it. It covers the Android app, Tailscale sign-in, the three modes, public access and its timer, router forwarding, server lock, the port, update and uninstall, and common problems. The same words are in the README.
- The mode choice recommends Tailscale and selects it by default. The note says Tailscale is safer because nothing is opened to the internet and only signed-in devices can reach Drivebay, while Regular mode exposes the port publicly. Tailscale + Local (Both) is the third choice. It keeps Tailscale on and adds a public path that starts off. `DRIVEBAY_SETUP_MODE=both` selects it without prompts. The router steps show for Both and for Regular.
- In Both mode, settings shows **Public access: On** or **Off**. This PC and a signed-in device on the tailnet (`100.64.0.0/10` or `fd7a:115c:a1e0::/48`) can change it. A public or other LAN address cannot. The other server lock settings stay on this PC only. While public access is off, a browser on a public or LAN address gets a refusal page and no sign-in form. While it is on, that address gets the normal sign-in. Turn on can also set a timer of 1 hour, 4 hours, or 24 hours. A later Android build can show this state.
- No Tailscale (Regular mode) stays on the first install choice. After the port, setup prints this PC's local IP and public IP, then the router steps: log in (usually 192.168.0.1 or 192.168.1.1), forward TCP that port, reserve the PC in DHCP, and open `http://<public-ip>:<port>/` from outside. It notes that CGNAT can block this and that Tailscale is the easy fallback, and it says to use a strong password. The same steps show on this PC's settings page while Regular mode is on.
- Running the Windows install again updates Drivebay. The command-line script and the .exe stop the running copy, replace the program files, and keep the account, password, port, mode, and settings. They do not ask for a port, username, password, or Tailscale. The port check on an update ignores this Drivebay when it still holds its own port. After restart, setup calls `/api/health`. The script's last line is `Drivebay updated to 3.21`.
- A first-time Tailscale install asks "Do you already have Tailscale?" and selects Yes when Tailscale is already installed. Yes goes to the port, username, and password. No can download the official Windows installer (quiet MSI) and then walks through sign-in or creating a free account, or skip Tailscale and set it up later. Regular mode is unchanged. `DRIVEBAY_TAILSCALE=have`, `install`, or `skip` selects that step without prompts.
- Setup checks the chosen port before it saves. If Pinokio, Caddy, or any other program is already listening, it names that program and asks for another port. A scripted install stops with that same message. After start, setup calls `/api/health` and prints the ready line only when this Drivebay server answers. Uninstall says when a Pinokio copy is still running and leaves that copy running.
- Settings on this PC includes Get the Android app, with a link to the latest APK at https://github.com/lordstryfe/drivebay/releases/latest. The Google Play button stays hidden until `PLAY_STORE_URL` is set.
- Command-line uninstall: `irm https://raw.githubusercontent.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/main/uninstall.ps1 | iex`. It stops Drivebay, removes shortcuts and startup entries, and deletes the program files. It asks before deleting the saved account. `-KeepData` keeps that account. `-Force` deletes it. Installing again runs this uninstall first and keeps the account.
- Opening `/` in a browser on this PC shows sign-in when you are signed out, and settings after you sign in. A Tailscale or LAN address shows the file browser sign-in. Those pages are HTML. JSON errors stay on API calls.
- Settings on this PC can change Server lock: port, delete, rename, new folder, upload, max upload, and which drives or folders are allowed. The save is UTF-8 and takes effect immediately. Other devices can read the lock and cannot change it.
- Command-line setup no longer prints an error or stops when DrivebayTray.exe is not already running. If the tray cannot be built, the launcher starts instead and this PC still opens settings.
- The command-line install on main downloads the latest release server archive (`drivebay-server-win-x64.zip`). If that archive is missing, it downloads main. A checkout uses the files in that checkout. Opening `/` on this PC goes to settings, so the file list is not shown here.
- After the Windows .exe or command-line install, the first page asks you to sign in with the username and password from setup. It does not ask you to create the account again. Pinokio still creates the account on the first visit, because that install does not write a setup account file.
- Command-line Windows install (`install.ps1`). No installer and no Pinokio. It downloads the latest release server archive, or main when that archive is not published, installs a portable Node under `%LOCALAPPDATA%\Drivebay` when Node is missing, and runs the same Tailscale or Regular setup as the .exe installer. Regular mode requires a typed YES before it will continue, and tells you to forward the port. Tailscale skips that notice and can install Tailscale. A Start menu shortcut and `uninstall.ps1` are created. The password file is UTF-8.
- On this PC, Pinokio, the .exe installer, and the command-line install open the settings page when Drivebay starts. They do not open the file browser. The tray icon stays. Other devices still open the file browser at the shared address.

## 3.20
- Windows setup writes the username and password as UTF-16. Version 3.19 wrote them as ANSI, so an 8-character password looked too short and was not saved. A failed save now shows the reason.
- The standalone install adds a notification-area icon with Open, Copy address, Start, Stop, Restart, logs, Start with Windows, and Quit. The Start menu and sign-in startup open that icon instead of a console window. Uninstall stops it.
- Pinokio install and start behavior is unchanged.

## 3.19
- Installer strings are plain ASCII, so the Tailscale and Regular choices no longer show mojibake.
- Password confirmation compares the two fields. Matching passwords are saved and used for the web login.
- Tailscale mode skips the router port-forward page and checkbox. Regular mode still requires that acknowledgement. Both modes still choose a local port.

## 3.18
- Standalone Windows installer. No Pinokio, Node.js, or git required.
- Setup asks for Tailscale or regular mode, a free port, and the account password.
- Both modes show the chosen port and require you to forward it on your router.
- Tailscale mode can download the official Tailscale installer and launch Tailscale.
- Start menu, desktop shortcut, uninstaller, and optional start with Windows.
- Login from a Tailscale or LAN address uses the same plain-HTTP cookie rules as Pinokio.

## 3.17
- Settings **Drive access**: scan all drives on load; toggle any drive off; saved in `data/drive-access.json`.
- Disabled drives hidden from sidebar and blocked for browse/download/upload/search.
- Android APK: downloads go to phone **Downloads** via DownloadManager (with session cookies).

## 3.16
- Server-lock policy (`data/server-lock.json` on host only): delete/rename/mkdir/upload/port/max upload/allowed roots.
- Settings shows live lock status (read-only from web/APK).
- File APIs enforce lock server-side; browser toolbar disables locked actions.
- Download route honors `allowedRoots`.

## 3.15
- Large files download via streaming `/api/download` (no more 24 MB base64 ceiling).
- Sort toolbar: name, type, size, date.
- Group by type (folders, images, videos, archives, etc.).
- Upload size ceiling raised to 512 MB (still base64-bound).

## 3.14
- Search walks subfolders.
- Hidden folders (`.` names) are included when the eye is on.
- Toggling the eye re-runs the current search.

## 3.13
- Opens on Home instead of Workspace.
- Settings shows the version number.
- Request a feature in Settings opens a GitHub issue.

## 3.12
- Home page no longer loads the file-browser module on the server (Windows 500).
- Update force-resets to GitHub main.

## 3.11
- Removed leftover file-list code that crashed the home page.

## 3.10
- Fixed vite.config.ts typo that blocked Start.

## 3.9
- Stopped a Windows database crash from returning JSON 500.

## 3.8
- Search this folder (Enter or Ctrl/Cmd+K).

## 3.7
- Settings page (password + port).
- Login lock stored in `data/` so Update does not wipe it.

## 3.6
- Random or static port at Install / Set port.

## 3.5
- Static port picker for router forwarding.

## 3.4
- Login works from public / Tailscale / phone addresses.

## 3.3
- Pinokio package, X: and Z: drives, password lock, file browser.
