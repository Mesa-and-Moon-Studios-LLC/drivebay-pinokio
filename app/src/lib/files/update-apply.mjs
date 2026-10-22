import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  isAllowedDownloadUrl,
  platformId,
  readInstalledVersion,
  writeUpdateStatus,
} from "./update-policy.mjs";

const execFileAsync = promisify(execFile);

export const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
export const MAX_REDIRECTS = 5;

export function hasExistingInstall(home) {
  return Boolean(home) && fs.existsSync(path.join(home, "config.json"));
}

/** A one-click update only runs when this copy is already installed and the asset URL is a GitHub host. */
export function applyPlan(status) {
  const action = status?.action;
  if (action !== "required" && action !== "optional") return { ok: false, reason: "current" };
  const fileName = String(status.fileName || "");
  const url = String(status.downloadUrl || "");
  if (!fileName || !url || !isAllowedDownloadUrl(url)) return { ok: false, reason: "no-asset" };
  if (status.platform === "win-x64" || fileName.endsWith(".exe")) {
    return { ok: true, kind: "windows-installer", fileName, url, args: ["/S"] };
  }
  if (fileName.endsWith(".tar.gz")) {
    return { ok: true, kind: "unix-tarball", fileName, url, args: [] };
  }
  return { ok: false, reason: "no-asset" };
}

export function installCommand(plan, paths) {
  if (!plan?.ok) return null;
  if (plan.kind === "windows-installer") {
    return { file: paths.installer, args: ["/S"], env: {} };
  }
  if (plan.kind === "unix-tarball") {
    return {
      file: "bash",
      args: [path.join(paths.extractDir, "unix", "install.sh")],
      env: {
        DRIVEBAY_HOME: paths.home,
        DRIVEBAY_SOURCE: paths.extractDir,
      },
    };
  }
  return null;
}

export function unsafeTarEntry(name) {
  const text = String(name || "");
  if (!text || text.startsWith("/") || text.startsWith("\\") || /^[A-Za-z]:/.test(text)) return true;
  return text.split(/[/\\]/).some((part) => part === "..");
}

export function listUnsafeTarEntries(names) {
  return (Array.isArray(names) ? names : []).filter((name) => unsafeTarEntry(name));
}

export function payloadKind(fileName, header) {
  const bytes = Buffer.isBuffer(header) ? header : Buffer.from(header || []);
  if (String(fileName).toLowerCase().endsWith(".exe")) {
    return bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a ? "exe" : "";
  }
  if (String(fileName).toLowerCase().endsWith(".tar.gz") || String(fileName).toLowerCase().endsWith(".tgz")) {
    return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b ? "gzip" : "";
  }
  return "";
}

export async function followDownload(url, fetchImpl, redirects = 0) {
  if (!isAllowedDownloadUrl(url)) return { ok: false, reason: "url" };
  if (redirects > MAX_REDIRECTS) return { ok: false, reason: "redirects" };
  const res = await fetchImpl(url, {
    redirect: "manual",
    headers: { "user-agent": "Drivebay", accept: "application/octet-stream" },
  });
  const status = Number(res?.status || 0);
  if (status >= 300 && status < 400) {
    const loc = res.headers?.get?.("location") || "";
    if (!loc) return { ok: false, reason: "redirects" };
    let next = "";
    try {
      next = new URL(loc, url).href;
    } catch {
      return { ok: false, reason: "url" };
    }
    return followDownload(next, fetchImpl, redirects + 1);
  }
  if (status !== 200) return { ok: false, reason: "http" };
  return { ok: true, response: res };
}

export async function saveDownload(url, dest, fetchImpl = globalThis.fetch) {
  const followed = await followDownload(url, fetchImpl);
  if (!followed.ok) return followed;
  const res = followed.response;
  const declared = Number(res.headers?.get?.("content-length") || "0");
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) return { ok: false, reason: "size" };
  if (typeof res.arrayBuffer !== "function") return { ok: false, reason: "payload" };
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DOWNLOAD_BYTES) return { ok: false, reason: "size" };
  const kind = payloadKind(path.basename(dest), buf.subarray(0, 4));
  if (!kind) return { ok: false, reason: "payload" };
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  fs.writeFileSync(part, buf);
  fs.renameSync(part, dest);
  return { ok: true, file: dest, kind };
}

export function spawnDetached(file, args, env) {
  const child = spawn(file, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env,
  });
  child.unref();
  return child.pid;
}

async function tarEntries(archive) {
  const { stdout } = await execFileAsync("tar", ["-tzf", archive], { maxBuffer: 8 * 1024 * 1024 });
  return String(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function runApply(options = {}) {
  const env = options.env || process.env;
  const home =
    options.home ||
    env.DRIVEBAY_HOME ||
    (platformId() === "win-x64"
      ? path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Drivebay")
      : path.join(os.homedir(), ".local", "share", "drivebay"));
  if (!hasExistingInstall(home)) return { ok: false, reason: "not-installed" };
  const versionFile = options.versionFile || env.DRIVEBAY_VERSION_FILE || "";
  let versionText = options.versionText || "";
  if (!versionText && versionFile) {
    try {
      versionText = fs.readFileSync(versionFile, "utf8");
    } catch {
      versionText = "";
    }
  }
  const status = await writeUpdateStatus(home, versionText, {
    force: true,
    platform: options.platform || platformId(),
    fetchImpl: options.fetchImpl,
  });
  const plan = applyPlan(status);
  if (!plan.ok) return plan;
  const dest = path.join(home, "updates", plan.fileName);
  const saved = await saveDownload(plan.url, dest, options.fetchImpl || globalThis.fetch);
  if (!saved.ok) return saved;
  if (plan.kind === "windows-installer") {
    const command = installCommand(plan, { installer: saved.file, home });
    const pid = (options.spawnImpl || spawnDetached)(command.file, command.args, { ...env });
    return { ok: true, started: true, kind: plan.kind, pid };
  }
  const extractDir = path.join(home, "updates", "extract");
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  const names = options.tarEntries || (await tarEntries(saved.file));
  const unsafe = listUnsafeTarEntries(names);
  if (unsafe.length) return { ok: false, reason: "archive" };
  if (!names.includes("unix/install.sh") && !names.includes("./unix/install.sh")) {
    return { ok: false, reason: "archive" };
  }
  if (!names.some((name) => name === "launcher.mjs" || name === "./launcher.mjs")) {
    return { ok: false, reason: "archive" };
  }
  if (!options.tarEntries) {
    await execFileAsync("tar", ["-xzf", saved.file, "-C", extractDir]);
  }
  const command = installCommand(plan, { extractDir, home });
  const pid = (options.spawnImpl || spawnDetached)(command.file, command.args, { ...env, ...command.env });
  return { ok: true, started: true, kind: plan.kind, pid, version: readInstalledVersion(versionText) };
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  runApply()
    .then((result) => {
      console.log(result.started ? "started" : result.reason || "none");
      process.exit(result.ok ? 0 : 1);
    })
    .catch(() => {
      console.log("none");
      process.exit(1);
    });
}
