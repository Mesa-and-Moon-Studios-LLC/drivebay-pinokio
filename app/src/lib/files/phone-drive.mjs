/**
 * Mount a phone that is sharing folders over WebDAV.
 * The phone address must be Tailscale (100.64.0.0/10), a private LAN address, or loopback.
 * The token or 6-digit code is the WebDAV password. The username is drivebay.
 *
 * Linux and macOS use the native mount when a desktop session and the native tool
 * are both present, and pass the code without asking. Otherwise they use rclone.
 * Windows stays on `net use`.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const RCLONE_MISSING =
  "rclone is not installed, so Drivebay cannot mount the phone without a desktop session. Install rclone and FUSE, then try again. On Linux, install the rclone and fuse3 packages (for example: sudo apt install rclone fuse3). On macOS: brew install rclone macfuse. Drivebay will not ask for the code in a prompt.";

const RCLONE_FAIL_NOTE =
  "If rclone reports that FUSE is missing, install it and try again (fuse3 on Linux, macFUSE on macOS). Drivebay does not ask for the code in a prompt.";

export function isMountableHost(host) {
  let value = String(host ?? "").trim().toLowerCase();
  if (!value) return false;
  if (value.startsWith("[")) value = value.slice(1).split("]")[0];
  const zone = value.indexOf("%");
  if (zone !== -1) value = value.slice(0, zone);
  if (value.startsWith("::ffff:")) value = value.slice("::ffff:".length);
  if (value.includes(":")) return value.startsWith("fd7a:115c:a1e0:") || value.startsWith("fe80:");
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : NaN));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = nums;
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export function redact(text, secret) {
  let raw = String(text ?? "");
  if (!secret) return raw;
  raw = raw.split(secret).join("***");
  const encoded = encodeURIComponent(secret);
  if (encoded && encoded !== secret) raw = raw.split(encoded).join("***");
  return raw;
}

function cleanUrl(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  let url;
  try {
    url = new URL(text.includes("://") ? text : `http://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!isMountableHost(url.hostname)) return null;
  if (!url.pathname || url.pathname === "") url.pathname = "/";
  return url;
}

/** A 6-digit code or a token of at least 8 characters. Shorter values are refused. */
export function acceptableSecret(secret) {
  const value = String(secret ?? "");
  if (!value) return false;
  return /^\d{6}$/.test(value.trim()) || value.length >= 8;
}

function commandOnPath(name) {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  try {
    const result = spawnSync(locator, [name], { stdio: "ignore", windowsHide: true });
    return result.status === 0;
  } catch {
    return false;
  }
}

export function detectTools(platform = process.platform) {
  return {
    gio: platform === "linux" && commandOnPath("gio"),
    mount_webdav: platform === "darwin" && commandOnPath("mount_webdav"),
    rclone: commandOnPath("rclone"),
  };
}

function dbusSession(env) {
  if (String(env.DBUS_SESSION_BUS_ADDRESS || "").trim()) return true;
  const runtime = String(env.XDG_RUNTIME_DIR || "").trim();
  if (!runtime) return false;
  try {
    return fs.existsSync(path.join(runtime, "bus"));
  } catch {
    return false;
  }
}

/**
 * Linux: a GUI session is DISPLAY or WAYLAND_DISPLAY plus a D-Bus session.
 * macOS: a desktop session is one that is not an SSH login. Headless SSH uses rclone.
 */
export function hasDesktopSession(platform, env = process.env) {
  const box = env || {};
  if (platform === "linux") {
    const gui = Boolean(String(box.DISPLAY || "").trim() || String(box.WAYLAND_DISPLAY || "").trim());
    return gui && dbusSession(box);
  }
  if (platform === "darwin") {
    return !String(box.SSH_CONNECTION || "").trim() && !String(box.SSH_TTY || "").trim();
  }
  return false;
}

function phoneMountPoint(home) {
  return path.join(home || os.homedir(), "DrivebayPhone");
}

function rclonePlan({ platform, href, userName, secret, mountPoint }) {
  return {
    ok: true,
    platform,
    method: "rclone",
    file: "rclone",
    args: [
      "mount",
      ":webdav:/",
      mountPoint,
      "--webdav-url",
      href,
      "--webdav-user",
      userName,
      "--webdav-pass",
      "\u0000webdav-pass",
      "--vfs-cache-mode",
      "writes",
      "--daemon",
    ],
    display: `rclone mount :webdav:/ ${mountPoint} --webdav-url ${href} --webdav-user ${userName} --webdav-pass *** --vfs-cache-mode writes --daemon`,
    mountPoint,
    createMountPoint: true,
    obscureSecret: String(secret),
    note: RCLONE_FAIL_NOTE,
  };
}

export function mountPlan({
  platform = process.platform,
  url,
  user = "drivebay",
  secret,
  letter = "Z",
  home,
  env = process.env,
  tools,
} = {}) {
  const parsed = cleanUrl(url);
  if (!parsed) {
    return { ok: false, error: "Use the Tailscale or LAN address shown in the Drivebay phone app." };
  }
  if (!acceptableSecret(secret)) {
    return { ok: false, error: "The phone token is required." };
  }
  const userName = String(user || "drivebay").trim() || "drivebay";
  const href = parsed.href.endsWith("/") ? parsed.href : `${parsed.href}/`;
  if (platform === "win32") {
    const drive = /^[A-Za-z]$/.test(String(letter || "")) ? String(letter).toUpperCase() : "Z";
    if (drive === "C") return { ok: false, error: "Pick a drive letter other than C." };
    return {
      ok: true,
      platform,
      method: "net",
      file: "net",
      letter: drive,
      args: ["use", `${drive}:`, href, `/user:${userName}`, String(secret)],
      display: `net use ${drive}: ${href} /user:${userName} ***`,
      note: "If Windows refuses the mount, start the WebClient service. HTTP Basic auth also needs BasicAuthLevel set to 2. See docs/phone-as-drive.md.",
    };
  }
  const root = home || os.homedir();
  const mountPoint = phoneMountPoint(root);
  const available = tools || detectTools(platform);
  const desktop = hasDesktopSession(platform, env);
  if (platform === "darwin" && desktop && available.mount_webdav) {
    const withUser = new URL(href);
    withUser.username = userName;
    withUser.password = String(secret);
    return {
      ok: true,
      platform,
      method: "mount_webdav",
      file: "mount_webdav",
      args: [withUser.href, mountPoint],
      display: `mkdir -p ${mountPoint} && mount_webdav http://${userName}:***@${parsed.host}/ ${mountPoint}`,
      mountPoint,
      createMountPoint: true,
      note: "macOS mounts the phone with mount_webdav. The folder is ~/DrivebayPhone. The code is passed to mount_webdav and is not requested again.",
    };
  }
  if (platform === "linux" && desktop && available.gio) {
    const dav = `dav://${encodeURIComponent(userName)}:${encodeURIComponent(String(secret))}@${parsed.host}${parsed.pathname}`;
    return {
      ok: true,
      platform,
      method: "gio",
      file: "gio",
      args: ["mount", dav],
      display: `gio mount dav://${userName}:***@${parsed.host}${parsed.pathname}`,
      note: "Linux mounts the phone with gio (gvfs) when a desktop session is available. The code is included so gio does not ask for it.",
    };
  }
  if (!available.rclone) {
    return { ok: false, error: RCLONE_MISSING };
  }
  return rclonePlan({ platform, href, userName, secret, mountPoint });
}

function davTarget(url, userName) {
  const parsed = cleanUrl(url);
  if (!parsed) return null;
  return `dav://${encodeURIComponent(userName)}@${parsed.host}${parsed.pathname}`;
}

export function unmountPlan({
  platform = process.platform,
  method = "",
  url,
  user = "drivebay",
  letter = "Z",
  mountPoint,
  home,
  env = process.env,
  tools,
} = {}) {
  const userName = String(user || "drivebay").trim() || "drivebay";
  let resolved = String(method || "");
  if (!resolved) {
    if (platform === "win32") resolved = "net";
    else if (platform === "darwin" && hasDesktopSession(platform, env) && (tools || detectTools(platform)).mount_webdav) {
      resolved = "mount_webdav";
    } else if (platform === "linux" && hasDesktopSession(platform, env) && (tools || detectTools(platform)).gio) {
      resolved = "gio";
    } else resolved = "rclone";
  }
  if (resolved === "net" || platform === "win32") {
    const drive = /^[A-Za-z]$/.test(String(letter || "")) ? String(letter).toUpperCase() : "Z";
    if (drive === "C") return { ok: false, error: "Pick a drive letter other than C." };
    return {
      ok: true,
      platform,
      method: "net",
      file: "net",
      args: ["use", `${drive}:`, "/delete", "/y"],
      display: `net use ${drive}: /delete /y`,
      note: "Windows removes the phone with net use /delete.",
    };
  }
  const dir = mountPoint || phoneMountPoint(home);
  if (resolved === "gio") {
    const dav = davTarget(url, userName);
    if (!dav) return { ok: false, error: "Use the Tailscale or LAN address shown in the Drivebay phone app." };
    return {
      ok: true,
      platform,
      method: "gio",
      file: "gio",
      args: ["mount", "-u", dav],
      display: `gio mount -u ${dav}`,
      note: "Linux removes the gio mount. The code is not requested.",
    };
  }
  if (resolved === "mount_webdav") {
    return {
      ok: true,
      platform,
      method: "mount_webdav",
      file: "umount",
      args: [dir],
      display: `umount ${dir}`,
      note: "macOS removes the mount_webdav folder with umount.",
    };
  }
  if (platform === "darwin") {
    return {
      ok: true,
      platform,
      method: "rclone",
      file: "umount",
      args: [dir],
      display: `umount ${dir}`,
      note: "macOS removes the rclone FUSE mount with umount.",
    };
  }
  return {
    ok: true,
    platform,
    method: "rclone",
    file: "fusermount",
    args: ["-u", dir],
    display: `fusermount -u ${dir}`,
    fallbacks: [
      { file: "fusermount3", args: ["-u", dir] },
      { file: "umount", args: [dir] },
    ],
    note: "Linux removes the rclone FUSE mount with fusermount -u, or umount if fusermount is missing.",
  };
}

/** hostname:port. This PC keeps a separate token for each phone address. */
export function phoneKey(url) {
  const parsed = cleanUrl(url);
  if (!parsed) return null;
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  return `${parsed.hostname}:${port}`;
}

export function rememberPhoneToken(records, { url, secret, peer, now, label, method, letter, mountPoint } = {}) {
  const key = phoneKey(url);
  if (!key || !secret) return { ...(records || {}) };
  const previous = (records || {})[key] || {};
  return {
    ...(records || {}),
    [key]: {
      url: String(url),
      secret: String(secret),
      peer: peer ? String(peer) : "",
      label: label ? pcName(label) : "",
      method: method != null ? String(method) : previous.method ? String(previous.method) : "",
      letter: letter != null ? String(letter) : previous.letter ? String(previous.letter) : "",
      mountPoint: mountPoint != null ? String(mountPoint) : previous.mountPoint ? String(previous.mountPoint) : "",
      seenAt: Number(now) || Date.now(),
    },
  };
}

export function tokenForPhone(records, url) {
  const key = phoneKey(url);
  if (!key || !records) return null;
  const row = records[key];
  return row && row.secret ? String(row.secret) : null;
}

/** Fields the browser may see. The token stays on the server. */
export function publicPhones(records) {
  return Object.entries(records || {}).map(([key, row]) => ({
    key,
    url: row && row.url ? String(row.url) : "",
    peer: row && row.peer ? String(row.peer) : "",
    label: row && row.label ? String(row.label) : "",
    seenAt: row && row.seenAt ? Number(row.seenAt) : 0,
  }));
}

export function forgetPhone(records, key) {
  const next = { ...(records || {}) };
  delete next[key];
  return next;
}

export function phoneTokenFile(home) {
  return path.join(home, "phone-tokens.json");
}

export function loadPhoneTokens(home) {
  if (!home) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(phoneTokenFile(home), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The name sent to the phone when the user left the pairing name blank. */
export function pcName(name = os.hostname()) {
  return String(name ?? "")
    .replace(/[\r\n]/g, " ")
    .trim()
    .slice(0, 40)
    .trim();
}

let lastPhoneName = "";

/** The name the phone sent on the last announcePc, or "" for an older app. */
export function announcedPhoneName() {
  return lastPhoneName;
}

/** The phone sends its name percent-encoded (X-Drivebay-Phone-Name). */
export function decodePhoneName(raw) {
  if (!raw) return "";
  try {
    return pcName(decodeURIComponent(String(raw)));
  } catch {
    return "";
  }
}

/** Explorer's MountPoints2 key for a WebDAV drive, e.g. ##100.70.170.22@8780#DavWWWRoot. */
export function mountPointsKey(url) {
  const parsed = cleanUrl(url);
  if (!parsed) return null;
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  const ssl = parsed.protocol === "https:" ? "@SSL" : "";
  return `##${parsed.hostname}${ssl}@${port}#DavWWWRoot`;
}

const MOUNT_POINTS = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\MountPoints2";

function runReg(args) {
  return new Promise((resolve) => {
    try {
      const child = spawn("reg.exe", args, { windowsHide: true, stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

/** Shows [label] for the mapped phone in File Explorer. Windows only; failure is ignored. */
export async function setDriveLabel(url, label, platform = process.platform) {
  const key = mountPointsKey(url);
  const name = pcName(label);
  if (platform !== "win32" || !key || !name) return false;
  return runReg(["add", `${MOUNT_POINTS}\\${key}`, "/v", "_LabelFromReg", "/t", "REG_SZ", "/d", name, "/f"]);
}

export async function clearDriveLabel(url, platform = process.platform) {
  const key = mountPointsKey(url);
  if (platform !== "win32" || !key) return false;
  return runReg(["delete", `${MOUNT_POINTS}\\${key}`, "/v", "_LabelFromReg", "/f"]);
}

/** Tells the phone this PC's hostname. Failure leaves the mount itself alone. */
export async function announcePc(url, secret, name = pcName()) {
  const parsed = cleanUrl(url);
  const hostName = pcName(name);
  if (!parsed || !secret || !hostName) return false;
  const href = parsed.href.endsWith("/") ? parsed.href : `${parsed.href}/`;
  const auth = Buffer.from(`drivebay:${secret}`).toString("base64");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(href, {
      method: "PROPFIND",
      headers: {
        Authorization: `Basic ${auth}`,
        Depth: "0",
        "X-Drivebay-PC-Name": hostName,
      },
      signal: controller.signal,
    });
    const ok = response.status === 207 || response.status === 200;
    lastPhoneName = ok ? decodePhoneName(response.headers.get("x-drivebay-phone-name")) : "";
    return ok;
  } catch {
    lastPhoneName = "";
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function savePhoneTokens(home, records) {
  if (!home) return false;
  fs.mkdirSync(home, { recursive: true });
  const file = phoneTokenFile(home);
  const tmp = `${file}.part`;
  fs.writeFileSync(tmp, `${JSON.stringify(records)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Some systems refuse chmod. The file is still the per-phone token store.
  }
  return true;
}

function runCommand(file, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: 1, output: err.message });
      return;
    }
    let output = "";
    let settled = false;
    const finish = (code, extra) => {
      if (settled) return;
      settled = true;
      resolve({ code, output: `${output}${extra || ""}`.trim() });
    };
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", (err) => finish(1, err.message));
    child.on("close", (code) => finish(code ?? 1, ""));
  });
}

export async function runMount(plan) {
  if (!plan?.ok) return { code: 1, output: plan?.error || "Cannot mount" };
  if (plan.createMountPoint && plan.mountPoint) fs.mkdirSync(plan.mountPoint, { recursive: true });
  let args = plan.args;
  let obscured = "";
  if (plan.obscureSecret) {
    const hidden = await runCommand("rclone", ["obscure", "--", String(plan.obscureSecret)]);
    obscured = hidden.output.trim().split(/\r?\n/).pop()?.trim() || "";
    if (hidden.code !== 0 || !obscured) {
      return {
        code: 1,
        output: redact(`${plan.note}\n${hidden.output}`.trim(), plan.obscureSecret),
      };
    }
    args = args.map((arg) => (arg === "\u0000webdav-pass" ? obscured : arg));
  }
  let result = await runCommand(plan.file, args);
  if ((result.code ?? 1) !== 0 && Array.isArray(plan.fallbacks)) {
    for (const next of plan.fallbacks) {
      result = await runCommand(next.file, next.args);
      if ((result.code ?? 1) === 0) break;
    }
  }
  let text = result.output || "";
  if (obscured) text = text.split(obscured).join("***");
  if (plan.obscureSecret) text = redact(text, plan.obscureSecret);
  text = text.trim();
  const code = result.code ?? 1;
  let body = text || (code === 0 ? plan.display : `${plan.note}\nThe mount command exited ${code}.`);
  if (code !== 0 && plan.method === "rclone" && text && plan.note && !body.includes(plan.note)) {
    body = `${body}\n${plan.note}`;
  }
  return { code, output: body };
}
