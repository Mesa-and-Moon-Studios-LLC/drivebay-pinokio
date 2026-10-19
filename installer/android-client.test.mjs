import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const android = path.join(root, "android");

function read(rel) {
  return fs.readFileSync(path.join(android, rel), "utf8");
}

test("android wrapper is version 3.34.3 and ignores secrets", () => {
  const gradle = read("app/build.gradle.kts");
  assert.match(gradle, /applicationId = "com\.mesaandmoon\.drivebay"/);
  assert.match(gradle, /versionCode = 33403/);
  assert.match(gradle, /versionName = "3\.34\.3"/);
  assert.equal(gradle.includes("signingConfigs"), false);
  assert.equal(gradle.includes("storePassword"), false);
  assert.equal(fs.existsSync(path.join(android, "gradlew")), true);
  const ignore = read(".gitignore");
  assert.match(ignore, /local\.properties/);
  assert.match(ignore, /\*\.jks/);
  assert.match(ignore, /\*\.keystore/);
  const leaked = [];
  for (const name of fs.readdirSync(android)) {
    if (/\.(jks|keystore)$/i.test(name) || name === "local.properties") leaked.push(name);
  }
  assert.deepEqual(leaked, []);
});

test("android download, tailscale, back, and port behavior is present", () => {
  const manifest = read("app/src/main/AndroidManifest.xml");
  assert.match(manifest, /FOREGROUND_SERVICE_DATA_SYNC/);
  assert.match(manifest, /DrivebayDownloadService/);
  assert.match(manifest, /com\.tailscale\.ipn/);
  assert.match(manifest, /maxSdkVersion="28"/);

  const main = read("app/src/main/java/com/lordstryfe/drivebay/MainActivity.kt");
  assert.match(main, /com\.tailscale\.ipn/);
  assert.match(main, /market:\/\/details\?id=/);
  assert.match(main, /__drivebayAndroidBack/);
  assert.match(main, /homeUrl/);
  assert.match(main, /isLegacyPort|legacy_port/);
  assert.match(main, /CookieManager/);
  const strings = read("app/src/main/res/values/strings.xml");
  assert.match(strings, /8765/);
  assert.match(strings, /8766/);
  const address = read("app/src/main/java/com/lordstryfe/drivebay/ServerAddress.kt");
  assert.match(address, /SUGGESTED_PORT = 8765/);
  assert.match(address, /42000/);
  assert.match(main, /DrivebayNative/);
  assert.match(main, /openAppSettings/);
  assert.match(main, /isAdminSettingsUrl/);
  assert.match(address, /fun isAdminSettingsPath/);

  const saver = read("app/src/main/java/com/lordstryfe/drivebay/MediaStoreSaver.kt");
  assert.match(saver, /MediaStore/);
  assert.match(saver, /Drivebay/);
  assert.match(saver, /DIRECTORY_DOWNLOADS/);

  const plan = read("app/src/main/java/com/lordstryfe/drivebay/DownloadPlan.kt");
  assert.match(plan, /8 \* 1024 \* 1024/);
  assert.match(plan, /backoffMs/);

  const service = read("app/src/main/java/com/lordstryfe/drivebay/DrivebayDownloadService.kt");
  assert.match(service, /ACTION_PAUSE/);
  assert.match(service, /ACTION_RESUME/);
  assert.match(service, /ACTION_CANCEL/);
  assert.match(service, /wifiOnly/);

  const route = fs.readFileSync(path.join(root, "app/src/routes/api/download.ts"), "utf8");
  assert.match(route, /HEAD:/);
  assert.match(route, /planDownload/);
  const browser = fs.readFileSync(path.join(root, "app/src/components/browser/app.tsx"), "utf8");
  assert.match(browser, /DrivebayNative/);
  assert.match(browser, /__drivebayAndroidBack/);
  assert.match(browser, /pickUpload/);
  assert.match(main, /fun pickUpload/);
  assert.match(main, /enableEdgeToEdge/);
  assert.match(main, /WindowInsetsCompat/);
  assert.match(main, /AppUpdateGate\.attach/);
  assert.match(main, /DownloadsList/);
  assert.match(service, /ACTION_JOBS_CHANGED/);
  assert.match(manifest, /PhoneShareService/);
  assert.match(manifest, /FOREGROUND_SERVICE_SPECIAL_USE/);
  const policy = fs.readFileSync(path.join(root, "server/drivebay/version.json"), "utf8");
  assert.match(policy, /"minVersionCode": 33400/);
  assert.match(policy, /"latestVersionCode": 33400/);
});
