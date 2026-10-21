/**
 * Mount a phone that is sharing folders over WebDAV.
 * The phone address must be Tailscale (100.64.0.0/10) or a private LAN address.
 * The token is the WebDAV password. The username is drivebay.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  const raw = String(text ?? "");
  if (!secret) return raw;
  return raw.split(secret).join("***");
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

export function mountPlan({ platform = process.platform, url, user = "drivebay", secret, letter = "Z", home } = {}) {
  const parsed = cleanUrl(url);
  if (!parsed) {
    return { ok: false, error: "Use the Tailscale or LAN address shown in the Drivebay phone app." };
  }
  if (!secret || String(secret).length < 8) {
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
      file: "net",
      args: ["use", `${drive}:`, href, `/user:${userName}`, String(secret)],
      display: `net use ${drive}: ${href} /user:${userName} ***`,
      note: "If Windows refuses the mount, start the WebClient service. HTTP Basic auth also needs BasicAuthLevel set to 2. See docs/phone-as-drive.md.",
    };
  }
  const root = home || os.homedir();
  const mountPoint = path.join(root, "DrivebayPhone");
  if (platform === "darwin") {
    const withUser = new URL(href);
    withUser.username = userName;
    withUser.password = String(secret);
    return {
      ok: true,
      platform,
      file: "mount_webdav",
      args: [withUser.href, mountPoint],
      display: `mkdir -p ${mountPoint} && mount_webdav http://${userName}:***@${parsed.host}/ ${mountPoint}`,
      mountPoint,
      note: "macOS mounts the phone with mount_webdav. The folder is ~/DrivebayPhone.",
    };
  }
  const dav = `dav://${encodeURIComponent(userName)}@${parsed.host}${parsed.pathname}`;
  return {
    ok: true,
    platform,
    file: "gio",
    args: ["mount", dav],
    display: `gio mount dav://${userName}:***@${parsed.host}${parsed.pathname}`,
    note: "Linux uses gio (gvfs). If gio is missing, install gvfs or davfs2 and follow docs/phone-as-drive.md. The token is the password gio asks for.",
  };
}

/** hostname:port. This PC keeps a separate token for each phone address. */
export function phoneKey(url) {
  const parsed = cleanUrl(url);
  if (!parsed) return null;
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  return `${parsed.hostname}:${port}`;
}

export function rememberPhoneToken(records, { url, secret, peer, now } = {}) {
  const key = phoneKey(url);
  if (!key || !secret) return { ...(records || {}) };
  return {
    ...(records || {}),
    [key]: {
      url: String(url),
      secret: String(secret),
      peer: peer ? String(peer) : "",
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

export function runMount(plan) {
  if (!plan?.ok) return Promise.resolve({ code: 1, output: plan?.error || "Cannot mount" });
  if (plan.mountPoint) fs.mkdirSync(plan.mountPoint, { recursive: true });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(plan.file, plan.args, { windowsHide: true });
    } catch (err) {
      resolve({ code: 1, output: `${plan.note}\n${err.message}` });
      return;
    }
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", (err) => {
      resolve({ code: 1, output: `${plan.note}\n${err.message}` });
    });
    child.on("close", (code) => {
      const text = output.trim();
      resolve({
        code: code ?? 1,
        output: text || (code === 0 ? plan.display : `${plan.note}\nThe mount command exited ${code ?? 1}.`),
      });
    });
  });
}
