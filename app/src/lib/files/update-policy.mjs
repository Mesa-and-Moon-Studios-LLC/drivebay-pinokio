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
export const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

const DOWNLOAD_HOSTS = new Set([
  "github.com",
  "api.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

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

/** True when a check should hit GitHub. A manual check always runs. */
export function shouldCheck(checkedAt, now, force, reason = "") {
  if (force) return true;
  const at = Number(checkedAt);
  if (!Number.isFinite(at) || at <= 0) return true;
  if (now < at) return true;
  const wait = reason === "unavailable" ? 60_000 : CHECK_INTERVAL_MS;
  return now - at >= wait;
}

/** Windows ships one x64 installer. Mac and Linux use the matching server archive. */
export function platformId(platform = process.platform, arch = process.arch) {
  if (platform === "win32") return "win-x64";
  if (platform !== "darwin" && platform !== "linux") return "";
  const arm = arch === "arm64" || arch === "aarch64";
  return `${platform}-${arm ? "arm64" : "x64"}`;
}

export function assetFileName(id, version) {
  const name = String(id || "");
  const release = String(version || "").trim();
  if (!name || !release) return "";
  if (name === "win-x64") return `Drivebay-Setup-${release}.exe`;
  return `drivebay-server-${name}.tar.gz`;
}

export function isAllowedDownloadUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (DOWNLOAD_HOSTS.has(host)) return true;
  return host.endsWith(".githubusercontent.com");
}

export function selectReleaseAsset(assets, id, version) {
  const fileName = assetFileName(id, version);
  if (!fileName) return null;
  const list = Array.isArray(assets) ? assets : [];
  const asset = list.find((item) => item && item.name === fileName);
  const downloadUrl = asset?.browser_download_url;
  if (!downloadUrl || !isAllowedDownloadUrl(downloadUrl)) return null;
  return { fileName, downloadUrl, platform: id };
}

export function describeDesktopUpdate(installed, manifest, assets, id) {
  const decision = decideUpdate(installed, manifest);
  const platform = id || "";
  const picked =
    decision.action === "required" || decision.action === "optional"
      ? selectReleaseAsset(assets, platform, manifest?.latest)
      : null;
  return {
    ...decision,
    platform,
    fileName: picked?.fileName || "",
    downloadUrl: picked?.downloadUrl || "",
  };
}

function readStatusFile(home) {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(home, "update-status.json"), "utf8"));
    if (!json || typeof json !== "object") return null;
    return json;
  } catch {
    return null;
  }
}

/**
 * @param {typeof fetch} [fetchImpl]
 * @param {string} [releasesUrl]
 */
export async function fetchLatestRelease(fetchImpl = globalThis.fetch, releasesUrl = RELEASES_LATEST) {
  if (typeof fetchImpl !== "function") return null;
  try {
    const releaseRes = await fetchImpl(releasesUrl, {
      headers: { accept: "application/vnd.github+json", "user-agent": "Drivebay" },
    });
    if (!releaseRes?.ok) return null;
    const release = await releaseRes.json();
    const assets = Array.isArray(release?.assets) ? release.assets : [];
    const asset = assets.find((item) => item && item.name === MANIFEST_NAME);
    if (!asset?.browser_download_url) return null;
    const body = await fetchImpl(asset.browser_download_url, {
      headers: { accept: "application/json", "user-agent": "Drivebay" },
    });
    if (!body?.ok) return null;
    const manifest = parseManifest(await body.text());
    if (!manifest) return null;
    return { manifest, assets };
  } catch {
    return null;
  }
}

/**
 * @param {typeof fetch} [fetchImpl]
 * @param {string} [releasesUrl]
 */
export async function fetchLatestManifest(fetchImpl = globalThis.fetch, releasesUrl = RELEASES_LATEST) {
  const release = await fetchLatestRelease(fetchImpl, releasesUrl);
  return release ? release.manifest : null;
}

export async function checkDesktopUpdate(versionText, options = {}) {
  const force = options.force === true;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const platform = options.platform || platformId();
  const previous = options.previous || null;
  if (previous?.action && !shouldCheck(previous.checkedAt, now, force, previous.reason)) {
    return previous;
  }
  const release = await fetchLatestRelease(options.fetchImpl, options.releasesUrl);
  const version = readInstalledVersion(versionText);
  if (!release) {
    if (previous && (previous.action === "required" || previous.action === "optional")) {
      return { ...previous, checkedAt: now };
    }
    return {
      action: "none",
      reason: "unavailable",
      latest: "",
      minimum: "",
      message: "",
      url: RELEASES_PAGE,
      platform,
      fileName: "",
      downloadUrl: "",
      version,
      checkedAt: now,
    };
  }
  return {
    ...describeDesktopUpdate(version, release.manifest, release.assets, platform),
    version,
    checkedAt: now,
  };
}

export async function writeUpdateStatus(home, versionText, options = {}) {
  const previous = readStatusFile(home);
  const decision = await checkDesktopUpdate(versionText, { ...options, previous });
  if (decision === previous) return previous;
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "update-status.json"), JSON.stringify(decision));
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
  const force = process.argv.includes("--force") || process.env.DRIVEBAY_UPDATE_FORCE === "1";
  writeUpdateStatus(home, text, { force })
    .then((decision) => {
      console.log(decision.action || "none");
    })
    .catch(() => {
      console.log("none");
    });
}
