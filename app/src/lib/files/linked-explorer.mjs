/**
 * Mount each linked own machine in Explorer or Finder, named after the device.
 * A loopback WebDAV proxy injects the grant token so Windows and macOS never
 * prompt for a password. The mapping stays on 127.0.0.1 even if the peer
 * address changes; the proxy reconnects when that machine comes back.
 */

import http from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isLoopbackAddress } from "./loopback.mjs";
import { connectionCandidates, pickDriveLetter } from "./linked-machines.mjs";
import { loadLinkedTokens, saveLinkedTokens } from "./linked-store.mjs";
import { runMount, setDriveLabel, clearDriveLabel, volumeLabel } from "./phone-drive.mjs";

export const PROXY_PORT_MIN = 18781;
export const PROXY_PORT_SPAN = 100;
export const FILE_SIZE_LIMIT = 4294967295;
const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
]);

/** @type {Map<string, { server: import("node:http").Server, port: number, state: object, localUrl: string }>} */
const proxies = new Map();
let refreshTimer = null;
let refreshHome = "";

export function preferredProxyPort(machineId) {
  const text = String(machineId || "");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return PROXY_PORT_MIN + (hash >>> 0) % PROXY_PORT_SPAN;
}

export function showInExplorerEnabled(row) {
  return row?.showInExplorer !== false;
}

export function mountPointsKeys(url, allowPublic = true) {
  let parsed;
  try {
    parsed = new URL(String(url || "").includes("://") ? String(url) : `http://${url}`);
  } catch {
    return [];
  }
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  const ssl = parsed.protocol === "https:" ? "@SSL" : "";
  const base = `##${parsed.hostname}${ssl}@${port}`;
  const keys = [`${base}#DavWWWRoot`];
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length) {
    keys.push(`${base}#${parts.join("#")}`);
    keys.push(`${base}#DavWWWRoot#${parts.join("#")}`);
  }
  return [...new Set(keys)];
}

export function localMountUrl(port, targetUrl) {
  let pathname = "/";
  try {
    pathname = new URL(targetUrl).pathname || "/";
  } catch {
    pathname = "/";
  }
  if (!pathname.endsWith("/")) pathname += "/";
  return `http://127.0.0.1:${Number(port)}${pathname}`;
}

export function rewriteDavHrefs(text, targetUrl, localUrl) {
  let body = String(text ?? "");
  if (!body || !targetUrl || !localUrl) return body;
  const trim = (value) => String(value).replace(/\/$/, "");
  const target = trim(targetUrl);
  const local = trim(localUrl);
  if (target && local && target !== local) body = body.split(target).join(local);
  try {
    const up = new URL(targetUrl);
    const here = new URL(localUrl);
    const upOrigin = trim(up.origin);
    const localOrigin = trim(here.origin);
    if (upOrigin && localOrigin && upOrigin !== localOrigin) body = body.split(upOrigin).join(localOrigin);
  } catch {
    /* keep whatever was already rewritten */
  }
  return body;
}

export function rewriteRequestDestination(value, localUrl, targetUrl) {
  if (!value) return value;
  return rewriteDavHrefs(String(value), localUrl, targetUrl);
}

export function basicAuthHeader(token) {
  return `Basic ${Buffer.from(`drivebay:${String(token || "")}`).toString("base64")}`;
}

export function parseNetUse(output) {
  const rows = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = line.match(/^\s*(\S+)?\s+([A-Za-z]:)\s+(\S+)/);
    if (!match) continue;
    const status = !match[1] || match[1] === "OK" || /^[A-Za-z]:$/.test(match[1]) ? (match[1] && !/^[A-Za-z]:$/.test(match[1]) ? match[1] : "OK") : match[1];
    const letter = (match[2] || match[1] || "").replace(":", "").toUpperCase();
    const remote = match[3];
    if (!/^[A-Z]$/.test(letter)) continue;
    rows.push({ letter, remote, status });
  }
  return rows;
}

/** net use prints Status / Local / Remote. A missing Status shifts the columns. */
export function parseNetUseRows(output) {
  const rows = [];
  for (const raw of String(output || "").split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim() || /^Status\b/i.test(line) || /^The command completed/i.test(line) || /^New connections/i.test(line) || /^-+$/.test(line.trim())) {
      continue;
    }
    const parts = line.trim().split(/\s+/);
    let status = "";
    let letter = "";
    let remote = "";
    if (parts[0] && /^[A-Za-z]:$/.test(parts[0])) {
      letter = parts[0].slice(0, 1).toUpperCase();
      remote = parts[1] || "";
      status = "";
    } else if (parts[1] && /^[A-Za-z]:$/.test(parts[1])) {
      status = parts[0];
      letter = parts[1].slice(0, 1).toUpperCase();
      remote = parts[2] || "";
    } else {
      continue;
    }
    rows.push({ letter, remote, status });
  }
  return rows;
}

export function mappingMatches(remote, localUrl) {
  if (!remote || !localUrl) return false;
  let parsed;
  try {
    parsed = new URL(localUrl);
  } catch {
    return false;
  }
  const port = parsed.port || "80";
  const host = parsed.hostname;
  const parts = parsed.pathname.split("/").filter(Boolean);
  const leaf = parts[parts.length - 1] || "DavWWWRoot";
  const text = String(remote).replace(/\//g, "\\");
  const needle = `\\\\${host}@${port}\\`;
  if (!text.toLowerCase().includes(needle.toLowerCase())) return false;
  if (parts.length === 0) return true;
  return text.toLowerCase().includes(`\\${leaf.toLowerCase()}`);
}

function runCommand(file, args, { input } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { windowsHide: true, stdio: [input != null ? "pipe" : "ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: 1, output: err.message || "spawn failed" });
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
    if (input != null && child.stdin) {
      child.stdin.end(String(input));
    }
    child.on("error", (err) => finish(1, err.message));
    child.on("close", (code) => finish(code ?? 1, ""));
  });
}

export function createMountProxy({ targetUrl, token, getTarget, getToken, localUrl }) {
  const state = { targetUrl: String(targetUrl || ""), token: String(token || ""), localUrl: String(localUrl || "") };
  const server = http.createServer((req, res) => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Drivebay mounts are only available on this computer.");
      return;
    }
    const upstream = String((getTarget && getTarget()) || state.targetUrl || "");
    const secret = String((getToken && getToken()) || state.token || "");
    let dest;
    try {
      dest = new URL(req.url || "/", upstream);
    } catch {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("That machine address is not valid.");
      return;
    }
    const headers = {};
    for (const [key, value] of Object.entries(req.headers || {})) {
      if (value == null || HOP.has(key.toLowerCase())) continue;
      headers[key] = value;
    }
    headers.host = dest.host;
    headers.authorization = basicAuthHeader(secret);
    if (headers.destination) {
      headers.destination = rewriteRequestDestination(headers.destination, state.localUrl || localUrl, upstream);
    }
    const lib = dest.protocol === "https:" ? https : http;
    const proxyReq = lib.request(
      {
        protocol: dest.protocol,
        hostname: dest.hostname.startsWith("[") ? dest.hostname.slice(1, -1) : dest.hostname,
        port: dest.port || (dest.protocol === "https:" ? 443 : 80),
        path: `${dest.pathname}${dest.search}`,
        method: req.method,
        headers,
      },
      (proxyRes) => {
        const out = { ...proxyRes.headers };
        const ctype = String(out["content-type"] || "");
        const rewrite = /xml|text/i.test(ctype);
        if (!rewrite) {
          res.writeHead(proxyRes.statusCode || 502, out);
          proxyRes.pipe(res);
          return;
        }
        const chunks = [];
        proxyRes.on("data", (chunk) => chunks.push(chunk));
        proxyRes.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          const text = rewriteDavHrefs(raw, upstream, state.localUrl || localUrl);
          const body = Buffer.from(text, "utf8");
          delete out["transfer-encoding"];
          delete out["content-length"];
          out["content-length"] = String(body.length);
          res.writeHead(proxyRes.statusCode || 502, out);
          res.end(body);
        });
      },
    );
    proxyReq.on("error", () => {
      if (!res.headersSent) res.writeHead(503, { "Content-Type": "text/plain" });
      if (!res.writableEnded) res.end("That machine is not reachable right now.");
    });
    req.pipe(proxyReq);
  });
  server.drivebayState = state;
  return server;
}

function listenOnPort(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off("listening", onListen);
      reject(err);
    };
    const onListen = () => {
      server.off("error", onError);
      resolve(port);
    };
    server.once("error", onError);
    server.once("listening", onListen);
    server.listen(port, "127.0.0.1");
  });
}

export async function startProxy({ machineId, targetUrl, token, port }) {
  const existing = proxies.get(machineId);
  if (existing) {
    existing.state.targetUrl = String(targetUrl || existing.state.targetUrl);
    existing.state.token = String(token || existing.state.token);
    existing.state.localUrl = localMountUrl(existing.port, existing.state.targetUrl);
    existing.localUrl = existing.state.localUrl;
    return existing;
  }
  const preferred = Number(port) || preferredProxyPort(machineId);
  const startAt = preferred >= PROXY_PORT_MIN && preferred < PROXY_PORT_MIN + PROXY_PORT_SPAN ? preferred : preferredProxyPort(machineId);
  let lastError = null;
  for (let offset = 0; offset < PROXY_PORT_SPAN; offset += 1) {
    const candidate = PROXY_PORT_MIN + ((startAt - PROXY_PORT_MIN + offset) % PROXY_PORT_SPAN);
    const stateRef = { targetUrl: String(targetUrl || ""), token: String(token || ""), localUrl: localMountUrl(candidate, targetUrl) };
    const server = createMountProxy({
      targetUrl,
      token,
      getTarget: () => stateRef.targetUrl,
      getToken: () => stateRef.token,
      localUrl: stateRef.localUrl,
    });
    server.drivebayState = stateRef;
    try {
      await listenOnPort(server, candidate);
      stateRef.localUrl = localMountUrl(candidate, targetUrl);
      const entry = { server, port: candidate, state: stateRef, localUrl: stateRef.localUrl };
      proxies.set(machineId, entry);
      return entry;
    } catch (err) {
      lastError = err;
      try {
        server.close();
      } catch {
        /* already closed */
      }
    }
  }
  throw lastError || new Error("No free loopback port for a Drivebay mount.");
}

export function stopProxy(machineId) {
  const entry = proxies.get(machineId);
  if (!entry) return false;
  try {
    entry.server.close();
  } catch {
    /* already closed */
  }
  proxies.delete(machineId);
  return true;
}

export function stopLinkedExplorer() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  refreshHome = "";
  for (const id of [...proxies.keys()]) stopProxy(id);
}

export async function queryWebClient() {
  if (process.platform !== "win32") return { platform: process.platform, running: true, needsAdmin: false, fileSizeLimit: FILE_SIZE_LIMIT, basicAuthLevel: 2 };
  const service = await runCommand("sc.exe", ["query", "WebClient"]);
  const config = await runCommand("sc.exe", ["qc", "WebClient"]);
  const fileSize = await runCommand("reg.exe", ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Services\\WebClient\\Parameters", "/v", "FileSizeLimitInBytes"]);
  const basic = await runCommand("reg.exe", ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Services\\WebClient\\Parameters", "/v", "BasicAuthLevel"]);
  const running = /STATE\s*:\s*\d+\s+RUNNING/i.test(service.output);
  const auto = /START_TYPE\s*:\s*2\s+AUTO/i.test(config.output);
  const fileSizeMatch = fileSize.output.match(/FileSizeLimitInBytes\s+REG_DWORD\s+0x([0-9a-f]+)/i);
  const basicMatch = basic.output.match(/BasicAuthLevel\s+REG_DWORD\s+0x([0-9a-f]+)/i);
  const fileSizeLimit = fileSizeMatch ? parseInt(fileSizeMatch[1], 16) : 0;
  const basicAuthLevel = basicMatch ? parseInt(basicMatch[1], 16) : 0;
  const needsAdmin = !auto || fileSizeLimit < FILE_SIZE_LIMIT || basicAuthLevel < 2;
  return { platform: "win32", running, auto, fileSizeLimit, basicAuthLevel, needsAdmin };
}

export async function ensureWebClient() {
  if (process.platform !== "win32") return { ok: true, needsAdmin: false, tweaks: [] };
  const started = await runCommand("sc.exe", ["start", "WebClient"]);
  const already = /already been started|1056/i.test(started.output);
  const tweaks = [];
  const config = await runCommand("sc.exe", ["config", "WebClient", "start=", "auto"]);
  if (config.code !== 0) tweaks.push("start=auto");
  const size = await runCommand("reg.exe", [
    "add",
    "HKLM\\SYSTEM\\CurrentControlSet\\Services\\WebClient\\Parameters",
    "/v",
    "FileSizeLimitInBytes",
    "/t",
    "REG_DWORD",
    "/d",
    String(FILE_SIZE_LIMIT),
    "/f",
  ]);
  if (size.code !== 0) tweaks.push("FileSizeLimitInBytes");
  const basic = await runCommand("reg.exe", [
    "add",
    "HKLM\\SYSTEM\\CurrentControlSet\\Services\\WebClient\\Parameters",
    "/v",
    "BasicAuthLevel",
    "/t",
    "REG_DWORD",
    "/d",
    "2",
    "/f",
  ]);
  if (basic.code !== 0) tweaks.push("BasicAuthLevel");
  const info = await queryWebClient();
  return {
    ok: info.running || started.code === 0 || already,
    needsAdmin: tweaks.length > 0,
    tweaks,
    ...info,
  };
}

export function explorerPlaceName(platform = process.platform) {
  if (platform === "win32") return "Explorer";
  if (platform === "darwin") return "Finder";
  return "Files";
}

export function explorerSupported(platform = process.platform) {
  return platform === "win32" || platform === "darwin" || platform === "linux";
}

function volumeFor(machine, saved, taken, machineId) {
  const raw = (machine && machine.displayName) || saved?.label || "Machine";
  return volumeLabel(raw, { taken, id: machineId }) || "Machine";
}

function realUserHome() {
  try {
    const home = os.userInfo().homedir;
    if (home) return home;
  } catch {
    /* fall through */
  }
  return os.homedir();
}

function darwinMountPoint(label) {
  const name = volumeLabel(label) || "Drivebay";
  return path.join("/Volumes", name);
}

function darwinFallbackMountPoint(label) {
  const name = volumeLabel(label) || "Drivebay";
  return path.join(realUserHome(), "Drivebay", name);
}

function linuxMountPoint(label, home) {
  const name = volumeLabel(label) || "Machine";
  return path.join(home || realUserHome(), "Drivebay", name);
}

export function isPathMounted(mountPoint) {
  if (!mountPoint) return false;
  try {
    if (!fs.existsSync(mountPoint)) return false;
    const st = fs.statSync(mountPoint);
    const parent = fs.statSync(path.dirname(mountPoint));
    return Number(st.dev) !== Number(parent.dev);
  } catch {
    return false;
  }
}

function mountWebdavBin() {
  return fs.existsSync("/sbin/mount_webdav") ? "/sbin/mount_webdav" : "mount_webdav";
}

async function runGuiCommand(file, args) {
  const first = await runCommand(file, args);
  if (first.code === 0 || process.platform !== "darwin") return first;
  try {
    const uid = os.userInfo().uid;
    return await runCommand("/bin/launchctl", ["asuser", String(uid), file, ...args]);
  } catch {
    return first;
  }
}

export async function listWindowsMappings() {
  const result = await runCommand("net", ["use"]);
  return parseNetUseRows(result.output);
}

export function isLocalMountPresent({ platform = process.platform, letter, mountPoint, localUrl, mappings }) {
  if (platform === "win32") {
    const rows = mappings || [];
    const want = String(letter || "").toUpperCase().replace(":", "").slice(0, 1);
    const row = rows.find((item) => item.letter === want);
    if (!row) return false;
    return mappingMatches(row.remote, localUrl);
  }
  return isPathMounted(mountPoint);
}

async function unmapLetter(letter) {
  const drive = String(letter || "").toUpperCase().replace(":", "").slice(0, 1);
  if (!/^[A-Z]$/.test(drive) || drive === "C") return { code: 1, output: "Pick a drive letter other than C." };
  return runCommand("net", ["use", `${drive}:`, "/delete", "/y"]);
}

async function mountWindows(letter, localUrl, label) {
  const drive = String(letter).toUpperCase();
  const mappings = await listWindowsMappings();
  const current = mappings.find((row) => row.letter === drive);
  if (current && mappingMatches(current.remote, localUrl)) {
    await setDriveLabel(localUrl, label, "win32", true);
    return { code: 0, output: `Mounted ${label}.`, already: true };
  }
  if (current) await unmapLetter(drive);
  const stale = mappings.find((row) => mappingMatches(row.remote, localUrl) && row.letter !== drive);
  if (stale) await unmapLetter(stale.letter);
  let result = await runMount({
    ok: true,
    platform: "win32",
    method: "net",
    file: "net",
    letter: drive,
    args: ["use", `${drive}:`, localUrl, "/persistent:yes"],
    display: `net use ${drive}: ${localUrl} /persistent:yes`,
    volumeName: label,
  });
  if (result.code !== 0) {
    result = await runMount({
      ok: true,
      platform: "win32",
      method: "net",
      file: "net",
      letter: drive,
      args: ["use", `${drive}:`, localUrl, "/user:drivebay", "local", "/persistent:yes"],
      display: `net use ${drive}: ${localUrl} /user:drivebay *** /persistent:yes`,
      volumeName: label,
    });
  }
  if (result.code === 0) await setDriveLabel(localUrl, label, "win32", true);
  return result;
}

async function mountOneWebdav(localUrl, label, mountPoint) {
  fs.mkdirSync(mountPoint, { recursive: true });
  const file = mountWebdavBin();
  const args = ["-s", "-v", String(label), String(localUrl), String(mountPoint)];
  const result = await runGuiCommand(file, args);
  return { ...result, mountPoint };
}

async function mountDarwin(localUrl, label) {
  const volumes = darwinMountPoint(label);
  try {
    fs.mkdirSync(volumes, { recursive: true });
    const result = await mountOneWebdav(localUrl, label, volumes);
    if (result.code === 0 && isPathMounted(volumes)) return result;
  } catch {
    /* /Volumes is often not writable; use a folder in the user home instead. */
  }
  const fallback = darwinFallbackMountPoint(label);
  const result = await mountOneWebdav(localUrl, label, fallback);
  return { ...result, mountPoint: fallback };
}

export async function occupiedWindowsLetters(platform = process.platform) {
  if (platform !== "win32") return [];
  const result = await runCommand("powershell.exe", [
    "-NoProfile",
    "-Command",
    "Get-CimInstance Win32_LogicalDisk | ForEach-Object { $_.DeviceID + ' ' + $_.DriveType + ' ' + $_.ProviderName }",
  ]);
  const used = new Set();
  for (const line of String(result.output || "").split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z]):\s+(\d+)(?:\s+(.*))?$/);
    if (!match) continue;
    const letter = match[1].toUpperCase();
    const type = Number(match[2]);
    const provider = String(match[3] || "");
    if (type === 4 && /127\.0\.0\.1@/i.test(provider)) continue;
    if (type === 4 && /Web Client Network/i.test(provider)) continue;
    used.add(letter);
  }
  return [...used];
}

export function resolvedLetter(records, machineId, requested, blocked = []) {
  const raw = String(requested || "").toUpperCase().replace(":", "").trim();
  const fromRequest = raw.length === 1 && /^[A-Z]$/.test(raw) && raw !== "C" ? raw : "";
  const saved = String(records?.[machineId]?.letter || "")
    .toUpperCase()
    .replace(":", "")
    .trim();
  const fromSaved = saved.length === 1 && /^[A-Z]$/.test(saved) && saved !== "C" ? saved : "";
  return pickDriveLetter(records, machineId, fromRequest || fromSaved || "P", blocked);
}

export async function mountLinkedMachine(home, machineId, { token, machine = {}, letter, scope, platform = process.platform } = {}) {
  const records = loadLinkedTokens(home);
  const saved = records[machineId] || {};
  const secret = String(token || saved.token || "");
  if (!secret) return { ok: false, message: "That machine is not paired on this computer." };
  if (!showInExplorerEnabled({ ...saved, showInExplorer: saved.showInExplorer })) {
    if (saved.showInExplorer === false) {
      await unmountLinkedMachine(home, machineId, { keepRecord: true, stop: true });
      return { ok: true, skipped: true, message: "Hidden from Explorer.", display: saved.label || "" };
    }
  }
  const target = String((machine && connectionCandidates(machine)[0]?.url) || saved.url || "");
  if (!target) return { ok: false, message: "That machine has no Tailscale or LAN address." };
  const taken = Object.entries(records)
    .filter(([id]) => id !== machineId)
    .map(([, row]) => row?.label || "")
    .filter(Boolean);
  const label = volumeFor(machine, saved, taken, machineId);
  const blocked = platform === "win32" ? await occupiedWindowsLetters(platform) : [];
  const drive = resolvedLetter(records, machineId, letter || saved.letter, blocked);
  const entry = await startProxy({
    machineId,
    targetUrl: target,
    token: secret,
    port: saved.proxyPort,
  });
  const next = {
    ...saved,
    token: secret,
    url: target,
    label,
    letter: drive,
    method: platform === "win32" ? "proxy-net" : platform === "darwin" ? "proxy-webdav" : "proxy",
    mountPoint: saved.mountPoint || "",
    via: saved.via || (machine && connectionCandidates(machine)[0]?.via) || "",
    scope: scope === "full" || saved.scope === "full" ? "full" : scope || saved.scope || "shares",
    showInExplorer: saved.showInExplorer !== false,
    proxyPort: entry.port,
    localUrl: entry.localUrl,
  };
  records[machineId] = next;
  saveLinkedTokens(home, records);

  if (platform === "win32") {
    const web = await ensureWebClient();
    const result = await mountWindows(drive, entry.localUrl, label);
    if (result.code === 0) {
      return {
        ok: true,
        message: next.scope === "full" ? `Mounted ${label} in Explorer.` : `Mounted ${label} in Explorer. Only its shared folders are visible.`,
        display: label,
        letter: drive,
        localUrl: entry.localUrl,
        scope: next.scope,
        needsAdmin: web.needsAdmin === true,
      };
    }
    return { ok: false, message: result.output || "Could not map that drive in Explorer.", display: label, needsAdmin: web.needsAdmin === true };
  }

  if (platform === "darwin") {
    if (isPathMounted(next.mountPoint)) {
      return { ok: true, message: `Mounted ${label} in Finder.`, display: label, mountPoint: next.mountPoint, scope: next.scope };
    }
    const result = await mountDarwin(entry.localUrl, label);
    if (result.code === 0) {
      records[machineId] = { ...next, mountPoint: result.mountPoint || next.mountPoint };
      saveLinkedTokens(home, records);
      return { ok: true, message: `Mounted ${label} in Finder.`, display: label, mountPoint: result.mountPoint, scope: next.scope };
    }
    return { ok: false, message: result.output || "Could not mount that machine in Finder.", display: label };
  }

  const mountPoint = linuxMountPoint(label, home);
  records[machineId] = { ...next, mountPoint };
  saveLinkedTokens(home, records);
  const result = await runMount({
    ok: true,
    platform,
    method: "rclone",
    file: "rclone",
    args: ["mount", ":webdav:/", mountPoint, "--webdav-url", entry.localUrl, "--vfs-cache-mode", "writes", "--daemon", "--volname", label],
    display: `rclone mount :webdav:/ ${mountPoint} --webdav-url ${entry.localUrl}`,
    mountPoint,
    createMountPoint: true,
    volumeName: label,
  });
  return {
    ok: result.code === 0,
    message: result.code === 0 ? `Mounted ${label}.` : result.output,
    display: label,
    mountPoint,
    scope: next.scope,
  };
}

export async function unmountLinkedMachine(home, machineId, { keepRecord = false, stop = true, forgetLabel = true } = {}) {
  const records = loadLinkedTokens(home);
  const saved = records[machineId];
  if (!saved) return { ok: true, message: "That machine is not saved on this computer." };
  const platform = process.platform;
  if (platform === "win32" && saved.letter) {
    await unmapLetter(saved.letter);
    if (forgetLabel && (saved.localUrl || saved.url)) await clearDriveLabel(saved.localUrl || saved.url, "win32");
  } else if (saved.mountPoint) {
    const umountFallbacks = platform === "linux"
      ? [
          { file: "fusermount3", args: ["-u", saved.mountPoint] },
          { file: "umount", args: [saved.mountPoint] },
        ]
      : [
          { file: "umount", args: ["-f", saved.mountPoint] },
          { file: "/usr/sbin/diskutil", args: ["unmount", "force", saved.mountPoint] },
        ];
    await runMount({
      ok: true,
      platform,
      method: "umount",
      file: platform === "linux" ? "fusermount" : "/sbin/umount",
      args: platform === "linux" ? ["-u", saved.mountPoint] : ["-f", saved.mountPoint],
      display: `umount ${saved.mountPoint}`,
      fallbacks: umountFallbacks,
    });
  }
  if (stop) stopProxy(machineId);
  if (!keepRecord) {
    delete records[machineId];
    saveLinkedTokens(home, records);
  } else {
    records[machineId] = { ...saved, localUrl: stop ? "" : saved.localUrl };
    saveLinkedTokens(home, records);
  }
  return { ok: true, message: "Unmounted." };
}

export async function setShowInExplorer(home, machineId, show, { machine } = {}) {
  const records = loadLinkedTokens(home);
  const saved = records[machineId];
  if (!saved?.token) return { ok: false, message: "That machine is not paired on this computer." };
  records[machineId] = { ...saved, showInExplorer: show === true };
  saveLinkedTokens(home, records);
  if (show) return mountLinkedMachine(home, machineId, { machine: machine || {}, token: saved.token, letter: saved.letter, scope: saved.scope });
  await unmountLinkedMachine(home, machineId, { keepRecord: true, stop: true });
  const still = loadLinkedTokens(home);
  if (still[machineId]) {
    still[machineId] = { ...still[machineId], showInExplorer: false };
    saveLinkedTokens(home, still);
  }
  return { ok: true, message: `Hidden from ${explorerPlaceName()}.`, display: saved.label || "" };
}

async function refreshTargets(home) {
  let listed = null;
  try {
    const cloud = await import("./linked-cloud.mjs");
    listed = await cloud.fetchMachines(home);
  } catch {
    listed = null;
  }
  const machines = new Map((listed?.machines || []).map((row) => [row.machineId, row]));
  const records = loadLinkedTokens(home);
  for (const [machineId, row] of Object.entries(records)) {
    if (!row?.token || !showInExplorerEnabled(row)) continue;
    const machine = machines.get(machineId);
    const entry = proxies.get(machineId);
    if (machine && entry) {
      const next = connectionCandidates(machine)[0];
      if (next?.url && next.url !== entry.state.targetUrl) {
        entry.state.targetUrl = next.url;
        entry.state.localUrl = localMountUrl(entry.port, next.url);
        entry.localUrl = entry.state.localUrl;
        records[machineId] = { ...row, url: next.url, via: next.via || row.via, localUrl: entry.localUrl };
      }
    }
    if (showInExplorerEnabled(row) && row.token) {
      await mountLinkedMachine(home, machineId, {
        token: row.token,
        machine: machine || {},
        letter: row.letter,
        scope: row.scope,
      }).catch(() => {});
    }
  }
  saveLinkedTokens(home, records);
}

export async function startLinkedExplorer(home, { intervalMs = 30_000, platform = process.platform } = {}) {
  if (!home) return { mounted: 0 };
  const records = loadLinkedTokens(home);
  let listed = null;
  try {
    const cloud = await import("./linked-cloud.mjs");
    listed = await cloud.fetchMachines(home);
  } catch {
    listed = null;
  }
  const machines = new Map((listed?.machines || []).map((row) => [row.machineId, row]));
  let mounted = 0;
  for (const [machineId, row] of Object.entries(records)) {
    if (!row?.token || !showInExplorerEnabled(row)) continue;
    const result = await mountLinkedMachine(home, machineId, {
      token: row.token,
      machine: machines.get(machineId) || {},
      letter: row.letter,
      scope: row.scope,
      platform,
    }).catch((err) => ({ ok: false, message: err?.message || "Could not mount." }));
    if (result?.ok && !result.skipped) mounted += 1;
  }
  if (intervalMs > 0 && refreshTimer == null) {
    refreshHome = home;
    refreshTimer = setInterval(() => {
      if (!refreshHome) return;
      void refreshTargets(refreshHome).catch(() => {});
    }, intervalMs);
    if (typeof refreshTimer.unref === "function") refreshTimer.unref();
  }
  return { mounted };
}

export async function publicExplorerStatus(home, platform = process.platform) {
  const records = loadLinkedTokens(home);
  const mappings = platform === "win32" ? await listWindowsMappings().catch(() => []) : [];
  const web = platform === "win32" ? await queryWebClient().catch(() => ({ needsAdmin: false })) : { needsAdmin: false };
  const links = {};
  for (const [machineId, row] of Object.entries(records)) {
    const localUrl = row.localUrl || (row.proxyPort ? localMountUrl(row.proxyPort, row.url) : "");
    const mounted = isLocalMountPresent({
      platform,
      letter: row.letter,
      mountPoint: row.mountPoint,
      localUrl,
      mappings,
    });
    links[machineId] = {
      showInExplorer: showInExplorerEnabled(row),
      letter: row.letter || "",
      label: row.label || "",
      mounted,
      localUrl: localUrl || "",
    };
  }
  return {
    supported: explorerSupported(platform),
    placeName: explorerPlaceName(platform),
    needsAdmin: web.needsAdmin === true,
    links,
  };
}
