/**
 * API tokens for Drivebay.
 * The secret is shown once. The file stores a SHA-256 hash and a short prefix.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const TOKEN_RE = /^db_[0-9a-f]{64}$/;
export const READ_SCOPE = ["roots", "list", "stat", "search", "download", "thumb"];
export const AUDIT_CAP = 200;
export const DEFAULT_RATE_PER_MINUTE = 60;

const buckets = new Map();

export function resetRateLimits() {
  buckets.clear();
}

export function hashToken(token) {
  return createHash("sha256").update(String(token), "utf8").digest("hex");
}

function emptyState() {
  return { version: 1, tokens: [], audit: [] };
}

function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeRoots(roots) {
  if (!Array.isArray(roots)) return [];
  const out = [];
  for (const root of roots) {
    if (typeof root !== "string") continue;
    const trimmed = root.trim();
    if (!trimmed || trimmed.length > 400) continue;
    out.push(trimmed);
  }
  return out.slice(0, 32);
}

function normalizeToken(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.id !== "string" || typeof raw.hash !== "string" || typeof raw.name !== "string") return null;
  const scope = Array.isArray(raw.scope) ? raw.scope.filter((item) => READ_SCOPE.includes(item)) : READ_SCOPE.slice();
  return {
    id: raw.id,
    name: raw.name.slice(0, 80),
    prefix: typeof raw.prefix === "string" ? raw.prefix.slice(0, 16) : "",
    hash: raw.hash,
    scope: scope.length ? scope : READ_SCOPE.slice(),
    roots: normalizeRoots(raw.roots),
    expiresAt: asNumber(raw.expiresAt),
    createdAt: asNumber(raw.createdAt) ?? 0,
    lastUsedAt: asNumber(raw.lastUsedAt),
  };
}

function normalizeState(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== "object") return state;
  if (Array.isArray(raw.tokens)) {
    for (const token of raw.tokens) {
      const next = normalizeToken(token);
      if (next) state.tokens.push(next);
    }
  }
  if (Array.isArray(raw.audit)) {
    for (const entry of raw.audit) {
      if (!entry || typeof entry !== "object") continue;
      state.audit.push({
        at: asNumber(entry.at) ?? 0,
        tokenId: typeof entry.tokenId === "string" ? entry.tokenId : "",
        tokenName: typeof entry.tokenName === "string" ? entry.tokenName.slice(0, 80) : "",
        action: typeof entry.action === "string" ? entry.action.slice(0, 40) : "",
        path: typeof entry.path === "string" ? entry.path.slice(0, 1024) : "",
        status: asNumber(entry.status) ?? 0,
        detail: typeof entry.detail === "string" ? entry.detail.slice(0, 200) : "",
      });
    }
  }
  if (state.audit.length > AUDIT_CAP) state.audit = state.audit.slice(-AUDIT_CAP);
  return state;
}

export function readApiAccess(file) {
  try {
    return normalizeState(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return emptyState();
  }
}

function writeApiAccess(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}

export function publicToken(token, now) {
  const expired = token.expiresAt != null && token.expiresAt <= now;
  return {
    id: token.id,
    name: token.name,
    prefix: token.prefix,
    scope: token.scope.slice(),
    roots: token.roots.slice(),
    expiresAt: token.expiresAt,
    createdAt: token.createdAt,
    lastUsedAt: token.lastUsedAt,
    expired,
  };
}

export function createToken(file, input, now) {
  const name = String(input?.name ?? "").trim().slice(0, 80);
  if (!name) throw new Error("Name is required");
  const secret = `db_${randomBytes(32).toString("hex")}`;
  const expiresAt = input?.expiresAt == null || !Number.isFinite(Number(input.expiresAt)) ? null : Number(input.expiresAt);
  const record = {
    id: randomBytes(8).toString("hex"),
    name,
    prefix: secret.slice(0, 11),
    hash: hashToken(secret),
    scope: READ_SCOPE.slice(),
    roots: normalizeRoots(input?.roots),
    expiresAt,
    createdAt: now,
    lastUsedAt: null,
  };
  const state = readApiAccess(file);
  state.tokens.push(record);
  writeApiAccess(file, state);
  return { token: secret, record: publicToken(record, now) };
}

export function listTokens(file, now) {
  const state = readApiAccess(file);
  return state.tokens.map((token) => publicToken(token, now));
}

export function revokeToken(file, id) {
  const state = readApiAccess(file);
  const token = state.tokens.find((item) => item.id === id);
  if (!token) throw new Error("Token not found");
  state.tokens = state.tokens.filter((item) => item.id !== id);
  writeApiAccess(file, state);
  return { id };
}

export function authenticateToken(file, presented, now) {
  if (!TOKEN_RE.test(presented)) return null;
  const state = readApiAccess(file);
  const digest = Buffer.from(hashToken(presented), "hex");
  let found = null;
  for (const token of state.tokens) {
    const stored = Buffer.from(token.hash, "hex");
    if (stored.length !== digest.length) continue;
    if (timingSafeEqual(stored, digest)) found = token;
  }
  if (!found) return null;
  if (found.expiresAt != null && found.expiresAt <= now) return null;
  found.lastUsedAt = now;
  writeApiAccess(file, state);
  return found;
}

export function takeRate(bucketKey, now, limit = DEFAULT_RATE_PER_MINUTE) {
  const stamps = (buckets.get(bucketKey) || []).filter((at) => now - at < 60_000);
  if (stamps.length >= limit) {
    buckets.set(bucketKey, stamps);
    const retryAfter = Math.max(1, Math.ceil((stamps[0] + 60_000 - now) / 1000));
    return { ok: false, retryAfter };
  }
  stamps.push(now);
  buckets.set(bucketKey, stamps);
  return { ok: true, retryAfter: 0 };
}

export function appendAudit(file, entry) {
  const state = readApiAccess(file);
  state.audit.push({
    at: entry.at,
    tokenId: entry.tokenId || "",
    tokenName: entry.tokenName || "",
    action: String(entry.action || "").slice(0, 40),
    path: String(entry.path || "").slice(0, 1024),
    status: entry.status,
    detail: String(entry.detail || "").slice(0, 200),
  });
  if (state.audit.length > AUDIT_CAP) state.audit = state.audit.slice(-AUDIT_CAP);
  writeApiAccess(file, state);
}

export function listAudit(file) {
  return readApiAccess(file).audit.slice().reverse();
}

/** What the settings page may show. Creating and revoking a token stays on this PC. */
export function panelFor(file, access, now) {
  const loopback = Boolean(access?.loopback);
  if (!loopback) {
    return { canManage: false, tokens: [], audit: [] };
  }
  return {
    canManage: true,
    tokens: listTokens(file, now),
    audit: listAudit(file).slice(0, 50),
  };
}
