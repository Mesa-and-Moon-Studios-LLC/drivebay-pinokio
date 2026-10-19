import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Desktop update policy. Aaron's rule: once a release is published, older
 * builds are required to update. If GitHub cannot be read, the check fails open.
 *
 * The manifest is the version-manifest.json asset on the latest GitHub release.
 * A missing asset is the same as a failed check: the app keeps running.
 */

export const RELEASES_LATEST =
  "https://api.github.com/repos/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/releases/latest";
export const MANIFEST_NAME = "version-manifest.json";
export const RELEASES_PAGE =
  "https://github.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/releases/latest";

export function parseVersion(value) {
  const match = String(value ?? "").match(/(\d+(?:\.\d+)*)/);
  if (!match) return null;
  const parts = match[1].split(".").map((part) => Number(part));
  if (parts.some((part) => !Number.isInteger(part) || part < 0)) return null;
  return parts;
}

/** Negative when left is older. */
export function compareVersions(left, right) {
  const a = Array.isArray(left) ? left : parseVersion(left);
  const b = Array.isArray(right) ? right : parseVersion(right);
  if (!a || !b) return 0;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

export function parseManifest(text) {
  let json;
  try {
    json = JSON.parse(String(text ?? ""));
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;
  const minimum = typeof json.minimum === "string" ? json.minimum.trim() : "";
  const latest = typeof json.latest === "string" ? json.latest.trim() : "";
  if (!parseVersion(minimum) || !parseVersion(latest)) return null;
  const message = typeof json.message === "string" ? json.message.trim() : "";
  return { minimum, latest, message };
}

export function decideUpdate(installed, manifest) {
  if (!manifest) return { action: "none", reason: "unavailable" };
  const installedVersion = parseVersion(installed);
  if (!installedVersion) return { action: "none", reason: "unavailable" };
  const base = {
    latest: manifest.latest,
    minimum: manifest.minimum,
    message: manifest.message,
    url: RELEASES_PAGE,
  };
  if (compareVersions(installedVersion, manifest.minimum) < 0) {
    return { ...base, action: "required", reason: "below-minimum" };
  }
  if (compareVersions(installedVersion, manifest.latest) < 0) {
    return { ...base, action: "optional", reason: "below-latest" };
  }
  return { ...base, action: "none", reason: "current" };
}

export function readInstalledVersion(text) {
  const match = String(text ?? "").match(/(\d+\.\d+(?:\.\d+)*)/);
  return match ? match[1] : "";
}

/**
 * @param {typeof fetch} [fetchImpl]
 * @param {string} [releasesUrl]
 */
export async function fetchLatestManifest(fetchImpl = globalThis.fetch, releasesUrl = RELEASES_LATEST) {
  if (typeof fetchImpl !== "function") return null;
  try {
    const releaseRes = await fetchImpl(releasesUrl, {
      headers: { accept: "application/vnd.github+json", "user-agent": "Drivebay" },
    });
    if (!releaseRes.ok) return null;
    const release = await releaseRes.json();
    const assets = Array.isArray(release?.assets) ? release.assets : [];
    const asset = assets.find((item) => item && item.name === MANIFEST_NAME);
    if (!asset?.browser_download_url) return null;
    const body = await fetchImpl(asset.browser_download_url, {
      headers: { accept: "application/json", "user-agent": "Drivebay" },
    });
    if (!body.ok) return null;
    return parseManifest(await body.text());
  } catch {
    return null;
  }
}

export async function writeUpdateStatus(home, versionText) {
  const manifest = await fetchLatestManifest();
  const decision = decideUpdate(readInstalledVersion(versionText), manifest);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "update-status.json"), JSON.stringify({ ...decision, checkedAt: Date.now() }));
  return decision;
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  const home =
    process.env.DRIVEBAY_HOME ||
    (process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Drivebay")
      : path.join(os.homedir(), ".local", "share", "drivebay"));
  const versionFile =
    process.env.DRIVEBAY_VERSION_FILE || path.join(path.dirname(fileURLToPath(import.meta.url)), "VERSION.txt");
  let text = "";
  try {
    text = fs.readFileSync(versionFile, "utf8");
  } catch {
    text = "";
  }
  writeUpdateStatus(home, text)
    .then((decision) => {
      console.log(decision.action || "none");
    })
    .catch(() => {
      console.log("none");
    });
}
