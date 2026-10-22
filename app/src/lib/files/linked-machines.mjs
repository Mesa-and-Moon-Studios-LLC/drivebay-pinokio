/**
 * Linked machines for one Mesa and Moon login.
 * The cloud record is connection info only. Pair tokens, codes, folders,
 * and passwords stay on the machine that owns them.
 */

import crypto from "node:crypto";
import path from "node:path";
import { isTailnetAddress } from "./tailnet.mjs";
import { mountPlan, unmountPlan } from "./phone-drive.mjs";

export const CLOUD_KEYS = [
  "machineId",
  "displayName",
  "type",
  "tailscaleHost",
  "lanAddress",
  "port",
  "publicKey",
  "lastSeen",
  "hidden",
  "directInternet",
  "publicHost",
];

export const MACHINE_TYPES = ["pc", "mac", "linux", "phone"];

export const ONLINE_MS = 120_000;

export const DIRECT_INTERNET_WARNING =
  "Direct internet opens this port on the public network. Anyone who can reach that port can try to connect. Your files stay on this machine and do not pass through Mesa and Moon servers. This is less safe than Tailscale. Turn it on only if you forwarded the port yourself.";

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_FAILURES = 5;

export function machineType(platform) {
  if (platform === "darwin") return "mac";
  if (platform === "linux") return "linux";
  if (platform === "android") return "phone";
  return "pc";
}

export function newMachineId() {
  return crypto.randomUUID();
}

export function newMachineKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
}

export function hashSecret(secret, salt) {
  return crypto.createHash("sha256").update(String(salt)).update("\0").update(String(secret)).digest("hex");
}

function secretsEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function cleanText(value, max) {
  return String(value ?? "")
    .replace(/[\r\n\0]/g, " ")
    .trim()
    .slice(0, max);
}

function cleanHost(value) {
  let host = cleanText(value, 253).replace(/^\[|\]$/g, "");
  if (!host || /[\s/\\]/.test(host)) return "";
  return host;
}

/**
 * Accept a cloud body only when every key is connection info.
 * A password, token, code, or folder list refuses the whole body.
 */
export function sanitizeRegistration(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Machine record is not an object." };
  }
  const extra = Object.keys(input).filter((key) => !CLOUD_KEYS.includes(key));
  if (extra.length) return { ok: false, error: "That record is not connection info." };
  const machineId = cleanText(input.machineId, 64);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(machineId)) return { ok: false, error: "Machine id is invalid." };
  const displayName = cleanText(input.displayName, 80);
  if (!displayName) return { ok: false, error: "Display name is required." };
  const type = String(input.type || "");
  if (!MACHINE_TYPES.includes(type)) return { ok: false, error: "Machine type is invalid." };
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: "Port is invalid." };
  const publicKey = cleanText(input.publicKey, 4096);
  if (publicKey.length < 16) return { ok: false, error: "Public key is required." };
  const lastSeen = cleanText(input.lastSeen, 40);
  if (!Number.isFinite(Date.parse(lastSeen))) return { ok: false, error: "Last seen is invalid." };
  const directInternet = input.directInternet === true;
  return {
    ok: true,
    machine: {
      machineId,
      displayName,
      type,
      tailscaleHost: cleanHost(input.tailscaleHost),
      lanAddress: cleanHost(input.lanAddress),
      port,
      publicKey,
      lastSeen,
      hidden: input.hidden === true,
      directInternet,
      publicHost: directInternet ? cleanHost(input.publicHost) : "",
    },
  };
}

export function visibleMachines(machines, selfId) {
  const self = String(selfId || "");
  return (Array.isArray(machines) ? machines : []).filter((row) => {
    const clean = sanitizeRegistration(row);
    if (!clean.ok) return false;
    return !clean.machine.hidden || clean.machine.machineId === self;
  }).map((row) => sanitizeRegistration(row).machine);
}

export function isOnline(lastSeen, now = Date.now()) {
  const seen = Date.parse(lastSeen);
  if (!Number.isFinite(seen)) return false;
  const delta = now - seen;
  if (delta < -5000) return false;
  return delta <= ONLINE_MS;
}

function hostLiteral(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/**
 * Tailscale, then LAN. A public address is used only when this machine
 * recorded that the owner opened the port.
 */
export function connectionUrl(machine) {
  const clean = sanitizeRegistration(machine);
  if (!clean.ok) return { url: "", via: "", risk: false };
  const row = clean.machine;
  const pathName = row.type === "phone" ? "/" : "/dav/";
  let host = "";
  let via = "";
  if (row.tailscaleHost) {
    host = row.tailscaleHost;
    via = "tailscale";
  } else if (row.lanAddress) {
    host = row.lanAddress;
    via = "lan";
  } else if (row.directInternet && row.publicHost) {
    host = row.publicHost;
    via = "public";
  }
  if (!host) return { url: "", via: "", risk: false };
  return {
    url: `http://${hostLiteral(host)}:${row.port}${pathName}`,
    via,
    risk: via === "public",
  };
}

export function classifyAddresses(addresses) {
  let tailscaleHost = "";
  let lanAddress = "";
  for (const raw of addresses || []) {
    const host = cleanHost(raw);
    if (!host) continue;
    if (!tailscaleHost && isTailnetAddress(host)) {
      tailscaleHost = host;
      continue;
    }
    if (!lanAddress && isLan(host)) lanAddress = host;
  }
  return { tailscaleHost, lanAddress };
}

function isLan(host) {
  if (isTailnetAddress(host)) return false;
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((part) => Number(part));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = nums;
  if (a === 10 || (a === 192 && b === 168)) return true;
  return a === 172 && b >= 16 && b <= 31;
}

export function safeMountName(name, machineId = "") {
  const base = cleanText(name, 40).replace(/[^A-Za-z0-9._ -]+/g, "").trim().replace(/\s+/g, " ");
  const stem = base || "Machine";
  const suffix = cleanText(machineId, 8).slice(0, 4);
  return suffix ? `${stem} ${suffix}`.trim() : stem;
}

export function linkedMountPoint(home, name, machineId) {
  return path.join(home || "", "Drivebay", safeMountName(name, machineId));
}

export function linkedMountPlan({
  machine,
  secret,
  letter = "P",
  home,
  platform = process.platform,
  env,
  tools,
} = {}) {
  const target = connectionUrl(machine);
  if (!target.url) return { ok: false, error: "That machine has no Tailscale or LAN address." };
  if (target.risk && machine?.directInternet !== true) {
    return { ok: false, error: DIRECT_INTERNET_WARNING };
  }
  const clean = sanitizeRegistration(machine);
  const label = clean.ok ? clean.machine.displayName : "Drivebay";
  const mountPoint = platform === "win32" ? "" : linkedMountPoint(home, label, clean.ok ? clean.machine.machineId : "");
  const plan = mountPlan({
    platform,
    url: target.url,
    secret,
    letter,
    home,
    env,
    tools,
    mountPoint: mountPoint || undefined,
    allowPublic: target.risk,
    user: "drivebay",
  });
  if (!plan.ok) return plan;
  return { ...plan, volumeLabel: label, via: target.via, risk: target.risk, url: target.url };
}

export function linkedUnmountPlan(saved, options = {}) {
  if (!saved?.url) return { ok: false, error: "That machine is not mounted on this PC." };
  return unmountPlan({
    ...options,
    url: saved.url,
    method: saved.method,
    letter: saved.letter,
    mountPoint: saved.mountPoint,
    allowPublic: saved.via === "public",
    user: "drivebay",
  });
}

export function freshPairState() {
  return { code: null, grants: {}, pending: [] };
}

export function issueCode(state, { code, salt, now }) {
  return {
    ...state,
    code: {
      hash: hashSecret(code, salt),
      salt: String(salt),
      expiresAt: Number(now) + CODE_TTL_MS,
      failures: 0,
    },
  };
}

export function redeemCode(state, { code, peerId, name, now, token, tokenSalt }) {
  const current = state?.code;
  if (!current) return { ok: false, error: "This machine has no pairing code.", state };
  if (Number(now) > Number(current.expiresAt)) return { ok: false, error: "That pairing code expired.", state };
  if (current.failures >= MAX_CODE_FAILURES) {
    return { ok: false, error: "That pairing code is locked. Show a new code on this machine.", state };
  }
  if (!secretsEqual(hashSecret(code, current.salt), current.hash)) {
    return {
      ok: false,
      error: "That pairing code was refused.",
      state: { ...state, code: { ...current, failures: current.failures + 1 } },
    };
  }
  const id = cleanText(peerId, 64) || "peer";
  const granted = addGrant(state, { peerId: id, name, token, tokenSalt, now });
  return { ok: true, token: String(token), state: { ...granted, code: null } };
}

function addGrant(state, { peerId, name, token, tokenSalt, now }) {
  return {
    ...state,
    grants: {
      ...(state.grants || {}),
      [peerId]: {
        tokenHash: hashSecret(token, tokenSalt),
        salt: String(tokenSalt),
        name: cleanText(name, 80),
        createdAt: Number(now) || Date.now(),
      },
    },
  };
}

export function verifyPairToken(state, token) {
  const grants = Object.values(state?.grants || {});
  for (const grant of grants) {
    if (!grant?.salt || !grant.tokenHash) continue;
    if (secretsEqual(hashSecret(token, grant.salt), grant.tokenHash)) return true;
  }
  return false;
}

export function startRequest(state, { id, fromId, name, secret, salt, now }) {
  const pending = (state.pending || []).filter((row) => Number(now) - Number(row.at) < CODE_TTL_MS).slice(-19);
  pending.push({
    id: cleanText(id, 64),
    fromId: cleanText(fromId, 64),
    name: cleanText(name, 80),
    secretHash: hashSecret(secret, salt),
    salt: String(salt),
    at: Number(now),
    token: "",
    tokenSalt: "",
  });
  return { ...state, pending };
}

export function approveRequest(state, id, { token, tokenSalt, now }) {
  const pending = (state.pending || []).map((row) => {
    if (row.id !== id || row.token) return row;
    return { ...row, token: String(token), tokenSalt: String(tokenSalt) };
  });
  const row = pending.find((item) => item.id === id && item.token === String(token));
  if (!row) return { ok: false, error: "That approval request is gone.", state };
  const granted = addGrant({ ...state, pending }, {
    peerId: row.fromId || id,
    name: row.name,
    token,
    tokenSalt,
    now,
  });
  return { ok: true, state: granted };
}

export function pollRequest(state, { id, secret }) {
  let token = "";
  const pending = [];
  for (const row of state.pending || []) {
    if (row.id === id && row.token && secretsEqual(hashSecret(secret, row.salt), row.secretHash)) {
      token = row.token;
      continue;
    }
    pending.push(row);
  }
  if (!token) return { ok: false, error: "This machine has not approved that request yet.", state };
  return { ok: true, token, state: { ...state, pending } };
}

export function publicPairState(state) {
  return {
    codeActive: Boolean(state?.code) && state.code.failures < MAX_CODE_FAILURES,
    pending: (state?.pending || [])
      .filter((row) => !row.token)
      .map((row) => ({ id: row.id, fromId: row.fromId, name: row.name, at: row.at })),
    grants: Object.entries(state?.grants || {}).map(([id, grant]) => ({
      id,
      name: grant.name || "",
      createdAt: grant.createdAt || 0,
    })),
  };
}

export function normalizeShares(raw) {
  const folders = [];
  const seen = new Set();
  for (const row of raw?.folders || []) {
    const folderPath = String(row?.path ?? "").trim();
    if (!folderPath || folderPath.includes("\0")) continue;
    let name = safeMountName(row?.name || path.basename(folderPath.replace(/[\\/]+$/, "")));
    const key = name.toLowerCase();
    if (seen.has(key)) {
      let n = 2;
      while (seen.has(`${name} ${n}`.toLowerCase())) n += 1;
      name = `${name} ${n}`;
    }
    seen.add(name.toLowerCase());
    folders.push({
      path: folderPath,
      name,
      access: row?.access === "rw" ? "rw" : "ro",
    });
  }
  const directInternet = raw?.directInternet === true;
  return {
    hidden: raw?.hidden === true,
    directInternet,
    publicHost: directInternet ? cleanHost(raw?.publicHost) : "",
    folders,
  };
}

export function randomCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

export function randomToken() {
  return `dbp_${crypto.randomBytes(32).toString("hex")}`;
}

/** Pairing request ids stay inside the 64-character cloud and pair-state limit. */
export function randomRequestId() {
  return crypto.randomBytes(16).toString("hex");
}

const DRIVE_LETTERS = "PQRSTUVWXYZDEFGHIJKLMNOAB";

/** Each linked machine gets its own Windows letter. C is never used. */
export function pickDriveLetter(records, machineId, requested = "P") {
  const used = new Set();
  for (const [id, row] of Object.entries(records || {})) {
    if (id === machineId) continue;
    const letter = String(row?.letter || "").toUpperCase().replace(":", "").slice(0, 1);
    if (/^[A-Z]$/.test(letter)) used.add(letter);
  }
  const want = String(requested || "P").toUpperCase().replace(":", "").slice(0, 1);
  if (/^[A-Z]$/.test(want) && want !== "C" && !used.has(want)) return want;
  for (const letter of DRIVE_LETTERS) {
    if (!used.has(letter)) return letter;
  }
  return "P";
}

export function randomSalt() {
  return crypto.randomBytes(16).toString("hex");
}

