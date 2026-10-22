# Linked machines

Drivebay 3.37 can sign each machine into one Mesa and Moon account. The account is optional. Browse, the password lock, and phone-as-drive all work with nobody signed in.

The cloud stores connection info only: machine id, display name, type (`pc`, `mac`, `linux`, or `phone`), Tailscale address, LAN address, port, public key, and last seen. A hidden machine is left out of other machines' lists. A public address is stored only after the owner turns on direct internet and types the host. Your files never touch our servers. Folder lists, passwords, phone codes, and pair tokens are not uploaded. There is no relay. If a relay is ever added, it has to be end-to-end encrypted. This version does not have one.

## Sign in

On this PC, open Settings. **Continue with Google** and **Continue with Apple** use the same Firebase sign-in as the Mesa and Moon vault games. The buttons need `mesa-firebase.json` in the Drivebay data directory. Until that file exists they do not send a token, and Drivebay keeps working.

Signing in registers this machine. It repeats about once a minute while Drivebay is running so the others can see it as online (last seen within two minutes).

## My machines

Settings lists every machine on the login, with online or offline, and Connect. The address is the Tailscale address when the machine has one, then the LAN address. The public address is used only when that machine turned on direct internet. Connect over the public internet shows this warning and waits for a separate click:

Direct internet opens this port on the public network. Anyone who can reach that port can try to connect. Your files stay on this machine and do not pass through Mesa and Moon servers. This is less safe than Tailscale. Turn it on only if you forwarded the port yourself.

## Shared folders

Nothing is shared until you add a folder. Each folder is read-only or read-write. **Hidden** keeps this machine off the other machines' lists. The WebDAV server on this PC (`/dav/`) checks the list itself. A folder that is not on the list is not listed and is not readable. A read-only folder rejects upload, delete, and rename.

## Pairing

The account list is not permission to open a drive. The first connection needs a 6-digit code shown on the other machine, or Approve on that machine. Drivebay then keeps a pair token in `linked-tokens.json` on this PC only. The other machine stores a hash of that token in `pair-state.json`. A stolen Mesa and Moon login can see addresses. It cannot mount a drive without the code or the approval.

Phones still use the phone-as-drive code as the WebDAV password. Desktop machines exchange that code once for a longer token.

## Mounts

Each other machine becomes its own network drive, named with that machine's display name.

- Windows: `net use` on its own drive letter, with the Explorer label `_LabelFromReg`. The first machine uses P. The next machine uses the next free letter. C is never used.
- macOS: `mount_webdav` when this is a desktop session and `mount_webdav` is installed. Otherwise `rclone mount`.
- Linux: `gio mount` when `DISPLAY` or `WAYLAND_DISPLAY` is set and a D-Bus session is up. Otherwise `rclone mount`, same as phone-as-drive in 3.36.7.

The folder on macOS and Linux is `~/Drivebay/<machine name>`.

## Phones

The Android app in this repo has the same account buttons, a hidden switch, per-folder read-only or read-write, and My machines. Connect asks for the code, then lists that PC's shared folders inside the app. Android does not create an operating-system drive letter. PCs mount the phone with the existing phone-as-drive WebDAV port.

## Cloud API

`server/cloud-api/` is the PHP and MySQL API for HostGator. See `server/cloud-api/DEPLOY.md`. It is not deployed from this repository.
