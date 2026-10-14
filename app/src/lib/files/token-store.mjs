/**
 * API tokens for Drivebay.
 * The secret is shown once. The file stores a SHA-256 hash and a short prefix.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const TOKEN_RE = /^db_[0-9a-f]{64}$/;
export const READ_SCOPE = ["roots", "list", "stat", "search", "download", "thumb"];
export const WRITE_MINUTES = [15, 60, 240];
export const APPROVAL_TTL_MS = 10 * 60 * 1000;
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
  return { version: 1, tokens: [], approvals: [], audit: [] };
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
    scope,
    roots: normalizeRoots(raw.roots),
    expiresAt: asNumber(raw.expiresAt),
    createdAt: asNumber(raw.createdAt) ?? 0,
    lastUsedAt: asNumber(raw.lastUsedAt),
    writeUntil: asNumber(raw.writeUntil),
  };
}

function normalizeApproval(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.id !== "string" || typeof raw.tokenId !== "string") return null;
  const status = ["pending", "approved", "denied", "expired", "used"].includes(raw.status) ? raw.status : "expired";
  return {
    id: raw.id,
    tokenId: raw.tokenId,
    tokenName: typeof raw.tokenName === "string" ? raw.tokenName.slice(0, 80) : "",
    action: typeof raw.action === "string" ? raw.action : "",
    path: typeof raw.path === "string" ? raw.path.slice(0, 1024) : "",
    name: typeof raw.name === "string" ? raw.name.slice(0, 255) : null,
    size: asNumber(raw.size),
    status,
    grant: raw.grant === "once" || raw.grant === "window" ? raw.grant : null,
    windowMinutes: WRITE_MINUTES.includes(raw.windowMinutes) ? raw.windowMinutes : null,
    createdAt: asNumber(raw.createdAt) ?? 0,
    expiresAt: asNumber(raw.expiresAt) ?? 0,
    decidedAt: asNumber(raw.decidedAt),
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
  if (Array.isArray(raw.approvals)) {
    for (const approval of raw.approvals) {
      const next = normalizeApproval(approval);
      if (next) state.approvals.push(next);
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

function settle(state, now) {
  let changed = false;
  for (const approval of state.approvals) {
    const open = approval.status === "pending" || (approval.status === "approved" && approval.grant === "once");
    if (open && approval.expiresAt <= now) {
      approval.status = "expired";
      changed = true;
    }
  }
  return changed;
}

export function publicToken(token, now) {
  const writeOpen = token.writeUntil != null && token.writeUntil > now;
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
    writeUntil: writeOpen ? token.writeUntil : null,
    expired,
  };
}

export function publicApproval(approval) {
  return {
    id: approval.id,
    tokenId: approval.tokenId,
    tokenName: approval.tokenName,
    action: approval.action,
    path: approval.path,
    name: approval.name,
    size: approval.size,
    status: approval.status,
    grant: approval.grant,
    windowMinutes: approval.windowMinutes,
    createdAt: approval.createdAt,
    expiresAt: approval.expiresAt,
  };
}

export function createToken(file, input, now) {
  const name = String(input?.name ?? "").trim().slice(0, 80);
  if (!name) throw new Error("Name is required");
  const secret = `db_${randomBytes(32).toString("hex")}`;
  const record = {
    id: randomBytes(8).toString("hex"),
    name,
    prefix: secret.slice(0, 11),
    hash: hashToken(secret),
    scope: READ_SCOPE.slice(),
    roots: normalizeRoots(input?.roots),
    expiresAt: input?.expiresAt == null ? null : Number(input.expiresAt),
    createdAt: now,
    lastUsedAt: null,
    writeUntil: null,
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

export function revokeToken(file, id, now) {
  const state = readApiAccess(file);
  const token = state.tokens.find((item) => item.id === id);
  if (!token) throw new Error("Token not found");
  state.tokens = state.tokens.filter((item) => item.id !== id);
  for (const approval of state.approvals) {
    if (approval.tokenId === id && approval.status === "pending") approval.status = "denied";
  }
  settle(state, now);
  writeApiAccess(file, state);
  return { id };
}

export function allowWrite(file, id, minutes, now) {
  const windowMinutes = Number(minutes);
  if (!WRITE_MINUTES.includes(windowMinutes)) {
    throw new Error("Write window must be 15 minutes, 1 hour, or 4 hours.");
  }
  const state = readApiAccess(file);
  const token = state.tokens.find((item) => item.id === id);
  if (!token) throw new Error("Token not found");
  if (token.expiresAt != null && token.expiresAt <= now) throw new Error("Token is expired");
  token.writeUntil = now + windowMinutes * 60 * 1000;
  writeApiAccess(file, state);
  return publicToken(token, now);
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

function sameRequest(approval, spec) {
  return (
    approval.action === spec.action &&
    approval.path === spec.path &&
    (approval.name || null) === (spec.name || null) &&
    (approval.size ?? null) === (spec.size ?? null)
  );
}

export function ensureApproval(file, token, spec, now) {
  const state = readApiAccess(file);
  settle(state, now);
  const existing = state.approvals.find(
    (approval) => approval.status === "pending" && approval.tokenId === token.id && sameRequest(approval, spec),
  );
  if (existing) {
    writeApiAccess(file, state);
    return publicApproval(existing);
  }
  const approval = {
    id: randomBytes(12).toString("hex"),
    tokenId: token.id,
    tokenName: token.name,
    action: spec.action,
    path: String(spec.path || "").slice(0, 1024),
    name: spec.name ? String(spec.name).slice(0, 255) : null,
    size: spec.size == null ? null : Number(spec.size),
    status: "pending",
    grant: null,
    windowMinutes: null,
    createdAt: now,
    expiresAt: now + APPROVAL_TTL_MS,
    decidedAt: null,
  };
  state.approvals.push(approval);
  writeApiAccess(file, state);
  return publicApproval(approval);
}

export function matchApproval(file, tokenId, approvalId, spec, now) {
  const state = readApiAccess(file);
  const changed = settle(state, now);
  if (changed) writeApiAccess(file, state);
  const approval = state.approvals.find((item) => item.id === approvalId && item.tokenId === tokenId);
  if (!approval) return { found: false };
  if (!sameRequest(approval, spec)) return { found: true, status: "mismatch", approval: publicApproval(approval) };
  if (approval.status === "approved" && approval.grant === "once") {
    return { found: true, ok: true, approval: publicApproval(approval) };
  }
  return { found: true, status: approval.status, grant: approval.grant, approval: publicApproval(approval) };
}

export function markApprovalUsed(file, approvalId) {
  const state = readApiAccess(file);
  const approval = state.approvals.find((item) => item.id === approvalId);
  if (approval && approval.status === "approved") approval.status = "used";
  writeApiAccess(file, state);
}

export function readApprovalForToken(file, approvalId, tokenId, now) {
  const state = readApiAccess(file);
  const changed = settle(state, now);
  if (changed) writeApiAccess(file, state);
  const approval = state.approvals.find((item) => item.id === approvalId && item.tokenId === tokenId);
  return approval ? publicApproval(approval) : null;
}

export function listPendingApprovals(file, now) {
  const state = readApiAccess(file);
  const changed = settle(state, now);
  if (changed) writeApiAccess(file, state);
  return state.approvals.filter((approval) => approval.status === "pending").map(publicApproval);
}

export function decideApproval(file, id, allow, windowMinutes, now) {
  const state = readApiAccess(file);
  settle(state, now);
  const approval = state.approvals.find((item) => item.id === id);
  if (!approval || approval.status !== "pending") throw new Error("That request is no longer pending.");
  approval.decidedAt = now;
  if (!allow) {
    approval.status = "denied";
    approval.grant = null;
    approval.windowMinutes = null;
  } else if (windowMinutes) {
    const minutes = Number(windowMinutes);
    if (!WRITE_MINUTES.includes(minutes)) {
      throw new Error("Write window must be 15 minutes, 1 hour, or 4 hours.");
    }
    approval.status = "approved";
    approval.grant = "window";
    approval.windowMinutes = minutes;
    const token = state.tokens.find((item) => item.id === approval.tokenId);
    if (token) token.writeUntil = now + minutes * 60 * 1000;
  } else {
    approval.status = "approved";
    approval.grant = "once";
    approval.windowMinutes = null;
  }
  writeApiAccess(file, state);
  return publicApproval(approval);
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

/** What the settings page may show. Loopback manages tokens. Tailscale may open a write window. */
export function panelFor(file, access, now) {
  const loopback = Boolean(access?.loopback);
  const tailnet = Boolean(access?.tailnet);
  if (!loopback && !tailnet) {
    return { canManage: false, canWriteWindow: false, tokens: [], approvals: [], audit: [] };
  }
  const tokens = listTokens(file, now).map((token) => {
    if (loopback) return token;
    return {
      id: token.id,
      name: token.name,
      prefix: token.prefix,
      expiresAt: token.expiresAt,
      lastUsedAt: token.lastUsedAt,
      writeUntil: token.writeUntil,
      expired: token.expired,
    };
  });
  if (!loopback) {
    return { canManage: false, canWriteWindow: true, tokens, approvals: [], audit: [] };
  }
  return {
    canManage: true,
    canWriteWindow: true,
    tokens,
    approvals: listPendingApprovals(file, now),
    audit: listAudit(file).slice(0, 50),
  };
}
