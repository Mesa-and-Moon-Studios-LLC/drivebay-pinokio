import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assetFileName,
  checkDesktopUpdate,
  decideUpdate,
  describeDesktopUpdate,
  fetchLatestManifest,
  isAllowedDownloadUrl,
  parseManifest,
  platformId,
  readInstalledVersion,
  selectReleaseAsset,
  shouldCheck,
  compareVersions,
  CHECK_INTERVAL_MS,
} from "../app/src/lib/files/update-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("version compare treats 3.9 as older than 3.10", () => {
  assert.equal(compareVersions("3.9", "3.10"), -1);
  assert.equal(compareVersions("3.35", "3.36"), -1);
  assert.equal(compareVersions("3.36", "3.36"), 0);
  assert.equal(compareVersions("3.36.1", "3.36"), 1);
});

test("a version below the published minimum is required, and a failed check stays open", () => {
  const manifest = parseManifest(
    JSON.stringify({ minimum: "3.36", latest: "3.40", message: "Install the latest release." }),
  );
  assert.equal(decideUpdate("3.35", manifest).action, "required");
  assert.equal(decideUpdate("3.36", manifest).action, "optional");
  assert.equal(decideUpdate("3.40", manifest).action, "none");
  assert.equal(decideUpdate("3.35", null).action, "none");
  assert.equal(decideUpdate("3.35", null).reason, "unavailable");
  assert.equal(decideUpdate("not-a-version", manifest).reason, "unavailable");
  assert.equal(parseManifest("{"), null);
  assert.equal(parseManifest('{"minimum":"nope","latest":"3.36"}'), null);
});

test("the release asset is the only source, and a missing asset fails open", async () => {
  const offline = await fetchLatestManifest(async () => {
    throw new Error("offline");
  });
  assert.equal(offline, null);

  const missing = await fetchLatestManifest(async () => ({
    ok: true,
    json: async () => ({ assets: [{ name: "Drivebay-Setup.exe" }] }),
    text: async () => "",
  }));
  assert.equal(missing, null);

  const manifest = await fetchLatestManifest(async (url) => {
    if (String(url).includes("version-manifest.json")) {
      return {
        ok: true,
        text: async () => JSON.stringify({ minimum: "3.36", latest: "3.36", message: "Update." }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        assets: [{ name: "version-manifest.json", browser_download_url: "https://example.invalid/version-manifest.json" }],
      }),
    };
  });
  assert.equal(manifest.minimum, "3.36");
  assert.equal(decideUpdate("3.35", manifest).action, "required");
});

test("the repo manifest matches the server version and is not fetched from main", () => {
  const text = fs.readFileSync(path.join(root, "version-manifest.json"), "utf8");
  const manifest = parseManifest(text);
  const installed = readInstalledVersion(fs.readFileSync(path.join(root, "VERSION.txt"), "utf8"));
  assert.equal(installed, "3.36.4");
  assert.equal(manifest.latest, installed);
  assert.equal(decideUpdate(installed, manifest).action, "none");
  const policy = fs.readFileSync(path.join(root, "app/src/lib/files/update-policy.mjs"), "utf8");
  assert.match(policy, /releases\/latest/);
  assert.equal(policy.includes("raw.githubusercontent.com"), false);
  const install = fs.readFileSync(path.join(root, "install.ps1"), "utf8");
  assert.match(install, /This update is required/);
  assert.match(install, /Update check could not reach GitHub/);
});

const exeUrl =
  "https://github.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/releases/download/v3.36.4/Drivebay-Setup-3.36.4.exe";
const macUrl =
  "https://github.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/releases/download/v3.36.4/drivebay-server-darwin-arm64.tar.gz";

test("platform assets are the Windows installer and the matching server tarball", () => {
  assert.equal(platformId("win32", "arm64"), "win-x64");
  assert.equal(platformId("darwin", "arm64"), "darwin-arm64");
  assert.equal(platformId("linux", "x64"), "linux-x64");
  assert.equal(platformId("linux", "aarch64"), "linux-arm64");
  assert.equal(platformId("freebsd", "x64"), "");
  assert.equal(assetFileName("win-x64", "3.36.4"), "Drivebay-Setup-3.36.4.exe");
  assert.equal(assetFileName("darwin-arm64", "3.36.4"), "drivebay-server-darwin-arm64.tar.gz");
  assert.equal(isAllowedDownloadUrl(exeUrl), true);
  assert.equal(isAllowedDownloadUrl("https://objects.githubusercontent.com/releases/file"), true);
  assert.equal(isAllowedDownloadUrl("https://evil.example/Drivebay-Setup-3.36.4.exe"), false);
  assert.equal(isAllowedDownloadUrl("http://github.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/releases/latest"), false);
  assert.equal(isAllowedDownloadUrl("https://user:pass@github.com/file.exe"), false);
  const assets = [
    { name: "Drivebay-Setup-3.36.4.exe", browser_download_url: exeUrl },
    { name: "drivebay-server-darwin-arm64.tar.gz", browser_download_url: macUrl },
    { name: "Drivebay-Setup-3.36.4.exe", browser_download_url: "https://evil.example/setup.exe" },
  ];
  assert.equal(selectReleaseAsset(assets, "win-x64", "3.36.4").downloadUrl, exeUrl);
  assert.equal(selectReleaseAsset(assets, "darwin-arm64", "3.36.4").fileName, "drivebay-server-darwin-arm64.tar.gz");
  assert.equal(selectReleaseAsset(assets, "linux-x64", "3.36.4"), null);
  const manifest = { minimum: "3.36", latest: "3.36.4", message: "Update." };
  const required = describeDesktopUpdate("3.35", manifest, assets, "win-x64");
  assert.equal(required.action, "required");
  assert.equal(required.downloadUrl, exeUrl);
  const optional = describeDesktopUpdate("3.36.3", manifest, [], "darwin-arm64");
  assert.equal(optional.action, "optional");
  assert.equal(optional.downloadUrl, "");
  assert.equal(describeDesktopUpdate("3.36.4", manifest, assets, "win-x64").action, "none");
});

test("checks wait 12 hours unless forced, and a failed fetch keeps a required update", async () => {
  const now = 1_800_000_000_000;
  assert.equal(shouldCheck(now, now + CHECK_INTERVAL_MS - 1, false, "below-latest"), false);
  assert.equal(shouldCheck(now, now + CHECK_INTERVAL_MS, false, "below-latest"), true);
  assert.equal(shouldCheck(now, now + 1_000, true, "below-latest"), true);
  assert.equal(shouldCheck(now + 10_000, now, false, "below-latest"), true);
  assert.equal(shouldCheck(now, now + 59_000, false, "unavailable"), false);
  assert.equal(shouldCheck(now, now + 60_000, false, "unavailable"), true);

  let calls = 0;
  const previous = {
    action: "optional",
    reason: "below-latest",
    latest: "3.36.4",
    downloadUrl: exeUrl,
    checkedAt: now,
  };
  const held = await checkDesktopUpdate("3.36.3", {
    now: now + 1000,
    previous,
    fetchImpl: async () => {
      calls += 1;
      throw new Error("offline");
    },
  });
  assert.equal(calls, 0);
  assert.equal(held, previous);

  const kept = await checkDesktopUpdate("3.35", {
    now,
    previous: { action: "required", reason: "below-minimum", latest: "3.36.4", downloadUrl: exeUrl, checkedAt: now - CHECK_INTERVAL_MS },
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(kept.action, "required");
  assert.equal(kept.downloadUrl, exeUrl);
  assert.equal(kept.checkedAt, now);

  const open = await checkDesktopUpdate("3.36.4", {
    now,
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(open.action, "none");
  assert.equal(open.reason, "unavailable");
});
