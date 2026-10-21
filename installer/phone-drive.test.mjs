import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import os from "node:os";
import {
  forgetPhone,
  isMountableHost,
  loadPhoneTokens,
  mountPlan,
  pcName,
  phoneKey,
  publicPhones,
  redact,
  rememberPhoneToken,
  savePhoneTokens,
  tokenForPhone,
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
  });
  assert.equal(mac.ok, true);
  assert.equal(mac.file, "mount_webdav");
  assert.equal(mac.display.includes(secret), false);
  assert.equal(mac.mountPoint, path.join("/tmp/drivebay-home", "DrivebayPhone"));

  const linux = mountPlan({ platform: "linux", url: "http://10.0.0.4:8780/", secret });
  assert.equal(linux.ok, true);
  assert.equal(linux.file, "gio");
  assert.equal(linux.display.includes(secret), false);
  assert.match(linux.display, /gio mount/);
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
  assert.match(docs, /xattr -dr com\.apple\.quarantine/);
});
