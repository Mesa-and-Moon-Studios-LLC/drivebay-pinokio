# Changelog

All user-facing Drivebay versions. Newest first.

## 3.21
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
