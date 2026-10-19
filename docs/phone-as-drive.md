# Mount a phone as a drive

Drivebay can share folders you pick on the phone as a WebDAV drive. The PC then mounts that share on Tailscale or the local network. The share is off until you turn it on in the Android app.

The phone binds only to private and Tailscale addresses. It does not listen on a public address. The username is `drivebay`. The password is a token the app shows once. The phone stores a hash of that token, the same shape as a Drivebay API token (`db_` plus 64 hex characters).

## On the phone

1. Install Drivebay 3.34.0 or newer.
2. Open the app settings (the gear on the connect screen).
3. Under **Share this phone as a drive**, choose the folders to share. Android scoped storage keeps the choice as a document tree. Drivebay does not get access to folders you did not pick.
4. Tap **New token** and copy the token. Creating a new token replaces the old one.
5. Turn the switch on. A banner and a notification say **This phone is shared as a drive**, and they show an address such as `http://100.x.x.x:8780/`.
6. Leave the phone on the same Tailscale network, or on the same LAN, as the PC. Turn the switch off to stop sharing.

Port **8780** is the WebDAV port. Drivebay's own file server stays on its usual port (8765 unless you changed it).

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
