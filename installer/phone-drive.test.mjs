import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import os from "node:os";
import {
  announcePc,
  announcedPhoneName,
  decodePhoneName,
  forgetPhone,
  hasDesktopSession,
  isMountableHost,
  loadPhoneTokens,
  mountPlan,
  mountPointsKey,
  pcName,
  phoneKey,
  publicPhones,
  redact,
  rememberPhoneToken,
  savePhoneTokens,
  tokenForPhone,
  unmountPlan,
} from "../app/src/lib/files/phone-drive.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const secret = "db_" + "ab".repeat(32);

test("only Tailscale and private addresses can be mounted", () => {
  assert.equal(isMountableHost("100.64.0.8"), true);
  assert.equal(isMountableHost("192.168.1.20"), true);
  assert.equal(isMountableHost("10.1.2.3"), true);
  assert.equal(isMountableHost("fd7a:115c:a1e0::12"), true);
  assert.equal(isMountableHost("8.8.8.8"), false);
  assert.equal(isMountableHost("1.1.1.1"), false);
  assert.equal(isMountableHost("2001:db8::1"), false);
  const refused = mountPlan({ url: "http://8.8.8.8:8780/", secret });
  assert.equal(refused.ok, false);
});

test("mount plans redact the token and refuse drive C", () => {
  const windows = mountPlan({
    platform: "win32",
    url: "http://100.64.0.8:8780",
    secret,
    letter: "Z",
  });
  assert.equal(windows.ok, true);
  assert.equal(windows.display.includes(secret), false);
  assert.match(windows.display, /net use Z:/);
  assert.equal(windows.args.includes(secret), true);
  assert.match(redact(windows.args.join(" "), secret), /\*\*\*/);
  assert.equal(mountPlan({ platform: "win32", url: "http://192.168.1.9:8780/", secret, letter: "C" }).ok, false);

  const mac = mountPlan({
    platform: "darwin",
    url: "http://192.168.1.9:8780/",
    secret,
    home: "/tmp/drivebay-home",
    env: {},
    tools: { gio: false, mount_webdav: true, rclone: true },
  });
  assert.equal(mac.ok, true);
  assert.equal(mac.file, "mount_webdav");
  assert.equal(mac.method, "mount_webdav");
  assert.equal(mac.display.includes(secret), false);
  assert.equal(mac.mountPoint, path.join("/tmp/drivebay-home", "DrivebayPhone"));
  assert.equal(mac.args[0].includes(secret), true);

  const linux = mountPlan({
    platform: "linux",
    url: "http://10.0.0.4:8780/",
    secret,
    env: { DISPLAY: ":0", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" },
    tools: { gio: true, mount_webdav: false, rclone: true },
  });
  assert.equal(linux.ok, true);
  assert.equal(linux.file, "gio");
  assert.equal(linux.method, "gio");
  assert.equal(linux.display.includes(secret), false);
  assert.equal(linux.args.join(" ").includes(secret), true);
  assert.match(linux.display, /gio mount/);
  assert.equal(redact(linux.args.join(" "), secret).includes(secret), false);
});

test("a blank pairing name uses this PC's hostname", () => {
  assert.equal(pcName(" Office-PC\n"), "Office-PC");
  assert.equal(pcName("   "), "");
  assert.equal(pcName("x".repeat(50)).length, 40);
});

test("each phone keeps its own token and the browser copy omits it", () => {
  const first = "db_" + "ab".repeat(32);
  const second = "db_" + "cd".repeat(32);
  const replaced = "db_" + "ef".repeat(32);
  const saved = rememberPhoneToken(
    rememberPhoneToken({}, { url: "http://100.64.0.8:8780/", secret: first, peer: "a".repeat(16), now: 1 }),
    { url: "http://192.168.1.9:8780", secret: second, now: 2 },
  );
  assert.equal(phoneKey("http://100.64.0.8:8780/"), "100.64.0.8:8780");
  assert.equal(tokenForPhone(saved, "http://100.64.0.8:8780"), first);
  const again = rememberPhoneToken(saved, { url: "http://100.64.0.8:8780/", secret: replaced, now: 3 });
  assert.equal(tokenForPhone(again, "http://100.64.0.8:8780/"), replaced);
  assert.equal(tokenForPhone(again, "http://192.168.1.9:8780/"), second);
  const visible = JSON.stringify(publicPhones(again));
  assert.equal(visible.includes(replaced), false);
  assert.equal(visible.includes(second), false);
  assert.equal(tokenForPhone(forgetPhone(again, "100.64.0.8:8780"), "http://100.64.0.8:8780/"), null);
  assert.equal(tokenForPhone(forgetPhone(again, "100.64.0.8:8780"), "http://192.168.1.9:8780/"), second);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-phones-"));
  savePhoneTokens(home, again);
  const loaded = loadPhoneTokens(home);
  assert.equal(tokenForPhone(loaded, "http://192.168.1.9:8780/"), second);
  const mode = fs.statSync(path.join(home, "phone-tokens.json")).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("a 6-digit code is accepted and a shorter secret is refused", () => {
  const code = "123456";
  const windows = mountPlan({ platform: "win32", url: "http://127.0.0.1:8780/", secret: code, letter: "P" });
  assert.equal(windows.ok, true);
  assert.equal(windows.method, "net");
  assert.equal(windows.args.at(-1), code);
  assert.equal(mountPlan({ platform: "win32", url: "http://127.0.0.1:8780/", secret: "12345" }).ok, false);
  assert.equal(mountPlan({ platform: "win32", url: "http://127.0.0.1:8780/", secret: "1234567" }).ok, false);
});

test("linux and mac use rclone when there is no desktop session or native tool", () => {
  const headless = mountPlan({
    platform: "linux",
    url: "http://10.0.0.4:8780/",
    secret,
    home: "/tmp/drivebay-home",
    env: {},
    tools: { gio: true, mount_webdav: false, rclone: true },
  });
  assert.equal(headless.ok, true);
  assert.equal(headless.method, "rclone");
  assert.equal(headless.file, "rclone");
  assert.deepEqual(headless.args, [
    "mount",
    ":webdav:/",
    path.join("/tmp/drivebay-home", "DrivebayPhone"),
    "--webdav-url",
    "http://10.0.0.4:8780/",
    "--webdav-user",
    "drivebay",
    "--webdav-pass",
    "\u0000webdav-pass",
    "--vfs-cache-mode",
    "writes",
    "--daemon",
  ]);
  assert.equal(headless.display.includes(secret), false);
  assert.equal(headless.obscureSecret, secret);

  const waylandOnly = mountPlan({
    platform: "linux",
    url: "http://10.0.0.4:8780/",
    secret: "654321",
    env: { WAYLAND_DISPLAY: "wayland-0", XDG_RUNTIME_DIR: "/run/user/1000" },
    tools: { gio: false, rclone: true, mount_webdav: false },
  });
  assert.equal(waylandOnly.method, "rclone");

  const sshMac = mountPlan({
    platform: "darwin",
    url: "http://192.168.1.9:8780/",
    secret,
    home: "/tmp/drivebay-home",
    env: { SSH_CONNECTION: "1.2.3.4 22 5.6.7.8 22" },
    tools: { mount_webdav: true, rclone: true, gio: false },
  });
  assert.equal(sshMac.method, "rclone");

  const missing = mountPlan({
    platform: "linux",
    url: "http://10.0.0.4:8780/",
    secret,
    env: {},
    tools: { gio: false, rclone: false, mount_webdav: false },
  });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /rclone/);
  assert.match(missing.error, /FUSE/);
  assert.match(missing.error, /fuse3/);
  assert.match(missing.error, /macfuse/);

  const windows = mountPlan({
    platform: "win32",
    url: "http://10.0.0.4:8780/",
    secret,
    letter: "Z",
    env: { DISPLAY: ":0", DBUS_SESSION_BUS_ADDRESS: "unix:path=/bus" },
    tools: { gio: true, rclone: true, mount_webdav: true },
  });
  assert.equal(windows.method, "net");
  assert.match(windows.display, /net use Z:/);
  assert.equal(hasDesktopSession("linux", {}), false);
  assert.equal(hasDesktopSession("linux", { DISPLAY: ":0", DBUS_SESSION_BUS_ADDRESS: "unix:path=/bus" }), true);
  assert.equal(hasDesktopSession("darwin", { SSH_TTY: "/dev/pts/1" }), false);
  assert.equal(hasDesktopSession("darwin", {}), true);
});

test("each mount method has an unmount command that does not ask for the code", () => {
  const net = unmountPlan({ platform: "win32", method: "net", letter: "P", url: "http://10.0.0.4:8780/" });
  assert.equal(net.ok, true);
  assert.deepEqual(net.args, ["use", "P:", "/delete", "/y"]);
  assert.equal(net.display.includes(secret), false);

  const gio = unmountPlan({
    platform: "linux",
    method: "gio",
    url: "http://10.0.0.4:8780/",
    user: "drivebay",
  });
  assert.equal(gio.file, "gio");
  assert.deepEqual(gio.args, ["mount", "-u", "dav://drivebay@10.0.0.4:8780/"]);

  const fuse = unmountPlan({ platform: "linux", method: "rclone", mountPoint: "/mnt/phone" });
  assert.equal(fuse.file, "fusermount");
  assert.deepEqual(fuse.args, ["-u", "/mnt/phone"]);
  assert.equal(fuse.fallbacks[0].file, "fusermount3");
  assert.equal(fuse.fallbacks[1].file, "umount");

  const mac = unmountPlan({
    platform: "darwin",
    method: "mount_webdav",
    mountPoint: "/Users/a/DrivebayPhone",
  });
  assert.equal(mac.file, "umount");
  assert.deepEqual(mac.args, ["/Users/a/DrivebayPhone"]);

  const macRclone = unmountPlan({ platform: "darwin", method: "rclone", mountPoint: "/Users/a/DrivebayPhone" });
  assert.equal(macRclone.file, "umount");
});

test("the phone name and the Explorer label key come back from the share", async () => {
  assert.equal(decodePhoneName("Aaron%27s%20Phone"), "Aaron's Phone");
  assert.equal(decodePhoneName("%"), "");
  assert.equal(mountPointsKey("http://100.70.170.22:8780/"), "##100.70.170.22@8780#DavWWWRoot");
  assert.equal(mountPointsKey("https://100.64.0.8/"), "##100.64.0.8@SSL@443#DavWWWRoot");
  const saved = rememberPhoneToken({}, {
    url: "http://100.70.170.22:8780/",
    secret,
    label: "  Pixel\n",
    method: "net",
    letter: "Z",
    now: 4,
  });
  assert.equal(saved["100.70.170.22:8780"].label, "Pixel");
  assert.equal(saved["100.70.170.22:8780"].method, "net");
  const visible = JSON.stringify(publicPhones(saved));
  assert.match(visible, /Pixel/);
  assert.equal(visible.includes(secret), false);

  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(null, { status: 207, headers: { "x-drivebay-phone-name": "Work%20Phone" } });
  };
  try {
    const ok = await announcePc("http://127.0.0.1:8780/", secret, "Office-PC");
    assert.equal(ok, true);
    assert.equal(calls[0].init.method, "PROPFIND");
    assert.equal(calls[0].init.headers["X-Drivebay-PC-Name"], "Office-PC");
    assert.equal(calls[0].init.headers.Depth, "0");
    assert.match(calls[0].init.headers.Authorization, /^Basic /);
    assert.equal(announcedPhoneName(), "Work Phone");
  } finally {
    globalThis.fetch = original;
  }
});

test("the phone share stays off until the app turns it on", () => {
  const service = fs.readFileSync(
    path.join(root, "android/app/src/main/java/com/lordstryfe/drivebay/PhoneShareService.kt"),
    "utf8",
  );
  assert.match(service, /store\.enabled\(\)/);
  const store = fs.readFileSync(
    path.join(root, "android/app/src/main/java/com/lordstryfe/drivebay/PhoneShareStore.kt"),
    "utf8",
  );
  assert.match(store, /false/);
  const docs = fs.readFileSync(path.join(root, "docs/phone-as-drive.md"), "utf8");
  assert.match(docs, /BasicAuthLevel/);
  assert.match(docs, /mount_webdav/);
  assert.match(docs, /gio mount/);
  assert.match(docs, /rclone mount/);
  assert.match(docs, /fusermount -u/);
  assert.match(docs, /xattr -dr com\.apple\.quarantine/);
  const ui = fs.readFileSync(path.join(root, "app/src/components/settings/phone-drive.tsx"), "utf8");
  assert.match(ui, /6-digit code or token/);
  assert.match(ui, /Drive name in File Explorer/);
  assert.match(ui, /Unmount/);
  const fn = fs.readFileSync(path.join(root, "app/src/lib/files/phone-drive.functions.ts"), "utf8");
  assert.match(fn, /X-Drivebay-PC-Name|announcePc/);
  assert.match(fn, /phone-tokens\.json|savePhoneTokens/);
  assert.match(fn, /unmountPhoneDrive/);
});
