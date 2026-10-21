# Mount a phone as a drive

Drivebay can share folders you pick on the phone as a WebDAV drive. The PC then mounts that share on Tailscale or the local network. The share is off until you turn it on in the Android app.

The phone binds only to private and Tailscale addresses. It does not listen on a public address. The username is `drivebay`. The password is a token the app shows once. The phone stores a hash of that token, the same shape as a Drivebay API token (`db_` plus 64 hex characters).

## On the phone

1. Install Drivebay 3.34.0 or newer.
2. Open the app settings (the gear on the connect screen).
3. Under **Share this phone as a drive**, choose the folders to share. Android scoped storage keeps the choice as a document tree. Drivebay does not get access to folders you did not pick.
4. Set an owner password. It stays on the phone as a hash and is required to start sharing or to pair and revoke PCs. It is not the password the PC uses.
5. Tap **Pair a PC**. Each PC gets its own 6-digit code and token, shown once. Pair another PC the same way. Revoke drops that PC immediately. A phone that already had one token keeps it as the first paired PC, named This PC.
6. Turn the switch on. A banner and a notification say **This phone is shared as a drive**, and they show an address such as `http://100.x.x.x:8780/`. Several paired PCs can be connected at the same time.
7. Leave the phone on the same Tailscale network, or on the same LAN, as the PC. Turn the switch off to stop sharing. The paired PCs stay in the list.

The green banner is its own row under the status bar, above the New folder / Upload / Rename / Delete toolbar. The file list starts below that, so the first row is visible and scrolls.

Port **8780** is the WebDAV port. Drivebay's own file server stays on its usual port (8765 unless you changed it).

## If the phone or the PC restarts

The token hash, the folders, and the on/off switch stay on the phone. The token stays in Windows Credential Manager, and the last address stays in `%LOCALAPPDATA%\Drivebay\phone-mount.txt`. You do not enter the token again.

The phone starts the share again when the app process starts, including after a reboot, and keeps it in a foreground service when you leave the app. The banner says **Reconnecting...** until Tailscale or Wi-Fi is back, then **Connected** and the current address.

The PC tray checks again every 30 seconds, backing off to 5 minutes while the phone is away. It tries the saved address, then online Tailscale Android peers, then a reply on the LAN (UDP port 8781). A phone that moved to a new private address is mounted again. The tray menu and Connect my phone say **Reconnecting...** or **Connected**.

A refused token still stops the retries for that PC. Tap **Pair a PC** on the phone and paste that PC's new token once. Other paired PCs keep their own tokens. On this PC, Settings remembers a token per phone and can remount it without showing the token again. The Windows tray still keeps its token in Credential Manager, one target per paired phone.

## On Windows

The tray menu has **Mount phone as drive**. Settings on this PC has the same form. Enter the address from the phone and the token. The suggested drive letter is `Z:`. `C:` is refused.

The command is:

```
net use Z: http://100.x.x.x:8780/ /user:drivebay YOUR_TOKEN
```

Do not put the token in a script that gets logged. The tray and `installer/unix/mount-phone.sh` pass it through the environment.

Windows WebClient has to be running. HTTP Basic authentication over `http://` also needs this registry value, which an administrator sets once:

```
reg add HKLM\SYSTEM\CurrentControlSet\Services\WebClient\Parameters /v BasicAuthLevel /t REG_DWORD /d 2 /f
```

Then restart the WebClient service. Drivebay does not change that registry value itself.

`LOCK` is implemented so the Windows WebClient can mount the share. A `PROPFIND` with `Depth: infinity` is refused.

## On macOS

From the unpacked Drivebay folder:

```
bash unix/mount-phone.sh http://100.x.x.x:8780/
```

The script asks for the token and runs `mount_webdav`. The folder is `~/DrivebayPhone`.

The Mac server build is unsigned. If Gatekeeper blocks it, right-click the folder and choose Open, or run:

```
xattr -dr com.apple.quarantine /path/to/the/unpacked/folder
```

`unix/sign-mac.sh` prints that and can `codesign` later when `DRIVEBAY_CODESIGN_IDENTITY` is set. Notarization is documented there and stays off until `DRIVEBAY_NOTARY_PROFILE` is set. No signing key is in this repository.

## On Linux

```
bash unix/mount-phone.sh http://100.x.x.x:8780/
```

That runs `gio mount dav://drivebay@100.x.x.x:8780/`. `gio` asks for the token as the password. If `gio` is missing, install `gvfs` (the package that provides it).

A `davfs2` mount is the other option:

```
sudo mount -t davfs http://100.x.x.x:8780/ /mnt/phone
```

Use username `drivebay` and the token as the password. Prefer a user mount so the token is not stored in a world-readable secrets file.

## If the mount command is missing

The PC reports the error from `net`, `mount_webdav`, or `gio` and points back to this page. Any WebDAV client can also use the same address, username, and token. The phone does not open a second protocol for that case.
