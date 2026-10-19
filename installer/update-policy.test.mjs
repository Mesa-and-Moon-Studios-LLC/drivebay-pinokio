import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  decideUpdate,
  fetchLatestManifest,
  parseManifest,
  readInstalledVersion,
  compareVersions,
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
  assert.equal(installed, "3.36.2");
  assert.equal(manifest.latest, installed);
  assert.equal(decideUpdate(installed, manifest).action, "none");
  const policy = fs.readFileSync(path.join(root, "app/src/lib/files/update-policy.mjs"), "utf8");
  assert.match(policy, /releases\/latest/);
  assert.equal(policy.includes("raw.githubusercontent.com"), false);
  const install = fs.readFileSync(path.join(root, "install.ps1"), "utf8");
  assert.match(install, /This update is required/);
  assert.match(install, /Update check could not reach GitHub/);
});
