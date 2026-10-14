import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
});
