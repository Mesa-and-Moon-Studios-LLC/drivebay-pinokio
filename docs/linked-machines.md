# Linked machines

Drivebay 3.37 can sign each machine into one Mesa and Moon account. The account is optional. Browse, the password lock, and phone-as-drive all work with nobody signed in.

From 3.38, the cloud stores an encrypted machine directory. Your devices encrypt the public key, name, addresses, port, and hidden flag before anything is uploaded. The server also keeps a last-seen time in the clear so other machines can see if one is online, plus wrapped copies of the account key that only your passphrase, passkey, or recovery key can open. Until you lock the list, 3.37 still stores those connection fields in the clear so they can be migrated. A hidden machine is left out of other machines' lists. A public address is stored only after the owner turns on direct internet and types the host. Your files never touch our servers. Folder lists, passwords, phone codes, and pair tokens are not uploaded. There is no relay. If a relay is ever added, it has to be end-to-end encrypted. This version does not have one.

## Sign in

On this PC, open Settings. **Continue with Google**, **Continue with Apple**, and email with a password use the same Firebase account as the Mesa and Moon vault games. The buttons need `mesa-firebase.json` in the Drivebay data directory. Until that file exists they do not send a token, and Drivebay keeps working.

Email can create an account, sign in, sign out, and send a password reset email. The password goes to Firebase and is not written on this machine. Drivebay stores the Firebase ID token and refresh token in `mesa-account.json`, the same file Google and Apple use. An email that already belongs to Google or Apple is not a second account. Drivebay does not add a password onto that login. It tells you to use the Google or Apple button, so My machines, registration, the hidden flag, and shared folders stay on that one uid.

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

Each other machine becomes its own network drive. The name the person sees is that computer's display name, for example Aaron's Mac Mini. It is kept short. If two machines share a name, the second becomes Aaron's Mac Mini 2. A phone uses the name it sends on `X-Drivebay-Phone-Name`, unless you typed a drive name. Drivebay does not show a drive letter in Settings or the tray.

- Windows: `net use` still needs a letter. The first linked machine uses P. The next machine uses the next free letter. C is never used. The letter is not shown in Drivebay. Explorer shows the computer name from `_LabelFromReg` on that drive's MountPoints2 key. Explorer also draws the letter in parentheses, as in Aaron's Mac Mini (P:). `ShowDriveLettersFirst` can hide letters, but it hides them for every drive on the PC, including C:. Drivebay does not set it. There is no per-drive switch that removes the letter from Explorer.
- macOS: `mount_webdav -v` uses the computer name when this is a desktop session and `mount_webdav` is installed. Otherwise `rclone mount --volname` uses that name. The folder is `~/Drivebay/<computer name>`.
- Linux: `gio mount` when `DISPLAY` or `WAYLAND_DISPLAY` is set and a D-Bus session is up. The file manager name is the WebDAV display name, which is the computer name. Otherwise `rclone mount --volname`, same desktop check as phone-as-drive in 3.36.7, and the folder is `~/Drivebay/<computer name>`.

Phone-as-drive from 3.36.6 and 3.36.7 is unchanged aside from this name. The code or token is still the WebDAV password, and a blank drive name still uses the name the phone sends.

## Phones

The Android app in this repo has the same account buttons, a hidden switch, per-folder read-only or read-write, and My machines. Connect asks for the code, then lists that PC's shared folders inside the app. Android does not create an operating-system drive letter. PCs mount the phone with the existing phone-as-drive WebDAV port.

## Cloud API

`server/cloud-api/` is the PHP and MySQL API for HostGator. See `server/cloud-api/DEPLOY.md`. It is not deployed from this repository.
