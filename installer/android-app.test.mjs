import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isIpv4, localLanIpv4 } from "../app/src/lib/files/router-steps.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("settings offers the Android APK and hides Google Play until a URL is set", () => {
  const version = fs.readFileSync(path.join(root, "app/src/lib/version.ts"), "utf8");
  assert.match(version, /ANDROID_APK_URL = "https:\/\/github\.com\/lordstryfe\/drivebay\/releases\/latest"/);
  assert.match(version, /PLAY_STORE_URL = ""/);

  const settings = fs.readFileSync(path.join(root, "app/src/routes/settings.tsx"), "utf8");
  assert.match(settings, /Get the Android app/);
  assert.match(settings, /href=\{ANDROID_APK_URL\}/);
  assert.match(settings, /Android APK/);
  const play = settings.indexOf("{PLAY_STORE_URL ? (");
  const label = settings.indexOf("Google Play");
  const end = settings.indexOf(") : null}", label);
  assert.ok(play !== -1 && label > play && end > label);
  assert.match(settings, /reachMode === "regular"/);
  assert.match(settings, /No Tailscale \(Regular mode\)/);
  assert.match(settings, /192\.168\.0\.1/);
  assert.match(settings, /192\.168\.1\.1/);
  assert.match(settings, /CGNAT/);
  assert.match(settings, /Use a strong password/);
  const browser = fs.readFileSync(path.join(root, "app/src/components/browser/app.tsx"), "utf8");
  assert.equal(browser.includes("getRouterHelp"), false);
  const launcher = fs.readFileSync(path.join(root, "installer/launcher.mjs"), "utf8");
  assert.match(launcher, /DRIVEBAY_MODE:/);
});

test("LAN address helper returns a dotted IPv4 or nothing", () => {
  assert.equal(isIpv4("192.168.1.20"), true);
  assert.equal(isIpv4("10.0.0.2"), true);
  assert.equal(isIpv4("127.0.0.1"), true);
  assert.equal(isIpv4("192.168.1"), false);
  assert.equal(isIpv4("192.168.1.256"), false);
  assert.equal(isIpv4("nope"), false);
  const ip = localLanIpv4();
  assert.equal(ip === "" || isIpv4(ip), true);
  assert.notEqual(ip, "127.0.0.1");
});
