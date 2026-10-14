# Drivebay

Password-locked file browser for every drive on this machine. Built to run inside [Pinokio](https://pinokio.computer).

**Install this URL in Pinokio:**

```
https://github.com/lordstryfe/drivebay-pinokio
```

Current version: **3.21** — see [Changelog](#changelog) below.

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

Download **Drivebay-Setup-3.21.exe** from [GitHub Releases](https://github.com/lordstryfe/drivebay-pinokio/releases). You do not need Node.js, git, or Pinokio. The installer includes the server and the runtime that runs it, and it starts a production build.

Push a version tag such as `v3.21` to publish that file on the release. Pull requests also upload the installer as a build artifact.

The setup screens are:

1. **Welcome.** The runtime is included.
2. **Folder.** Where to put the program. This is a per-user install.
3. **Mode.** **Tailscale (Recommended)** is the default. Nothing is opened to the internet, and only your own signed-in devices can reach Drivebay. **No Tailscale (Regular mode)** exposes the port publicly and needs a router port forward.
4. **Tailscale** (only if you chose Tailscale). The page asks **Do you already have Tailscale?** and selects Yes when Tailscale is already installed. Yes goes on to the port, username, and password. No offers two choices: download and install Tailscale for Windows from the official installer (quiet MSI from `pkgs.tailscale.com`), then sign in or create a free Tailscale account, or **Skip**. Skip says you can install Tailscale and set it up later, then continues.
5. **Port.** Required in both modes. A free port from 1024 to 65535. The suggested port is 42013. This page runs on a first-time install.
6. **Router** (No Tailscale / Regular only). After the port is chosen, setup prints this PC's local IP, asks you to log in to the router (usually `http://192.168.0.1` or `http://192.168.1.1`), forward TCP **that port** to the local IP, and reserve that IP in DHCP. It prints the public IP when it can, and tells you to open `http://<public-ip>:<port>/` from outside the network. Some ISPs use CGNAT and block this. Tailscale is the easy fallback. Use a strong password. You must check the box to continue. Tailscale skips this page. Allow the same port in Windows Firewall if Windows asks. The same steps stay on this PC's settings page while Regular mode is on.
7. **Password.** The only username and password (at least 8 characters). The first launch asks you to sign in with that account. It does not ask you to create it again. If that account cannot be saved, setup shows the reason and writes the same text to the install log, and the login page then lets you set the lock.
8. **Shortcuts.** Start menu entries (Drivebay, Stop Drivebay, and Uninstall) are always created. They open a notification-area icon, not a console window. Optional desktop shortcut. Optional **Start Drivebay when I sign in to Windows**, which starts that same icon in the background.
9. **Finish.** On this PC, opens the settings page. It does not open the file browser. The icon stays while the server is running. Double-click it, or choose **Open settings**, to open settings again. The right-click menu can also copy the Tailscale or LAN address, start, stop, or restart the server, open the logs folder, turn **Start with Windows** on or off, or quit. A short notice appears when the server comes up. If the server stops on its own, the icon changes so you can see it. Other devices still open the file browser at the Tailscale or LAN address.

The password lock is unchanged: drives stay behind that login. Uninstall stops the tray icon and the server, removes the program, shortcuts, and the startup entry, and asks before deleting the saved password.

Tailscale and public addresses use the same plain-HTTP sign-in rules Pinokio already uses, so the login form works from a tailnet address. That does not turn the lock off.

If Drivebay is already installed, the .exe runs an update. It stops Drivebay, replaces the program files, and keeps the account, password, port, mode, and settings. It does not ask for the port, username, password, or Tailscale. It starts Drivebay again, checks `/api/health`, and the finish page says `Drivebay updated to 3.21`.

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

This copy of the script installs branch `cursor/windows-script-install-d803` and builds that server. It does not install the latest GitHub release or `main`. Release v3.20 has no server archive, so an earlier copy of this script downloaded `main`, and `main` opens the file browser on this PC. Running `install.ps1` from a checkout uses the files in that checkout. If Node.js 22 is missing, it downloads a portable Node into `%LOCALAPPDATA%\Drivebay` (no administrator account required).

Until this is on `main`, use the branch script:

```
irm https://raw.githubusercontent.com/lordstryfe/drivebay-pinokio/cursor/windows-script-install-d803/install.ps1 | iex
```

A first-time install asks for the same choices as the .exe installer:

1. **Mode.** Tailscale (Recommended) is the default. Press Enter to keep it. Nothing is opened to the internet, and only your own signed-in devices can reach Drivebay. No Tailscale (Regular mode) exposes the port publicly.
2. **Tailscale** (only if you chose Tailscale). It asks **Do you already have Tailscale?** and preselects Yes when `Tailscale.exe` is already installed. Yes goes straight to the port, username, and password. No offers: download and install Tailscale (the official quiet installer), then sign in or create a free account, or Skip. Skip prints that you can install Tailscale and set it up later, then continues. For a script, set `DRIVEBAY_TAILSCALE` to `have`, `install`, or `skip`.
3. **Port.** Required. A free port from 1024 to 65535. The suggested port is 42013. If that port is already in use, setup names the program and asks for another port.
4. **Router** (No Tailscale / Regular only). After the port, setup prints this PC's local IP and, when it can, the public IP. Log in to the router (usually `http://192.168.0.1` or `http://192.168.1.1`), forward TCP that port to the local IP, and give this PC a reserved or static DHCP address. From outside the network, open `http://<public-ip>:<port>/`. Some ISPs use CGNAT and block this. Tailscale is the easy fallback. Use a strong password. Type YES to continue. Tailscale skips this page. The same steps are on this PC's settings page while Regular mode is on.
5. **Password.** The only username and password (at least 8 characters). The password is saved as UTF-8 in `%LOCALAPPDATA%\Drivebay\pending-account.json`, the same file the .exe installer writes. The first launch signs in with that account. It does not ask you to create it again.

If Drivebay is already installed (`config.json`, or a saved port plus the account or `data` folder), the script runs an update. It stops Drivebay, replaces the program files, and keeps the account, password, port, mode, and settings. It does not ask for a port, username, password, or Tailscale. A port check during the update ignores this Drivebay if it still holds its own port. After restart it checks `/api/health`. The last line is `Drivebay updated to 3.21`.

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

Until this is on `main`, use the branch script:

```
irm https://raw.githubusercontent.com/lordstryfe/drivebay-pinokio/cursor/windows-script-install-d803/uninstall.ps1 | iex
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

## Changelog

### 3.21
- The install mode choice recommends Tailscale and selects it by default. Tailscale keeps the port off the public internet. Regular mode exposes it.
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
