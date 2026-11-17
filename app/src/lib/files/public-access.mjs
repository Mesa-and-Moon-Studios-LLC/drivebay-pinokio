/**
 * Tailscale + Local (Both) keeps Tailscale open.
 * The router path is Public access, and it starts off.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isLoopbackAddress } from "./loopback.mjs";
import { isTailnetAddress } from "./tailnet.mjs";
import { formatCountdown, REMOTE_ACCESS_BANNER, REMOTE_ACCESS_BANNER_TITLE } from "./linked-copy.mjs";
export { formatCountdown, REMOTE_ACCESS_BANNER, REMOTE_ACCESS_BANNER_TITLE };

/**
 * @param {unknown} enabled
 * @param {unknown} offAt
 * @param {number} now
 */
export function publicAccessOpen(enabled, offAt, now) {
  if (enabled !== true) return false;
  if (offAt == null) return true;
  if (typeof offAt !== "number" || !Number.isFinite(offAt)) return true;
  return now < offAt;
}

/**
 * @param {string | null | undefined} mode
 * @param {string | null | undefined} address
 * @param {{ enabled?: boolean, offAt?: number | null } | null | undefined} access
 * @param {number} now
 * @returns {"allow" | "deny"}
 */
export function requestReach(mode, address, access, now) {
  if (mode !== "both") return "allow";
  if (isLoopbackAddress(address) || isTailnetAddress(address)) return "allow";
  if (publicAccessOpen(access?.enabled, access?.offAt ?? null, now)) return "allow";
  return "deny";
}

/**
 * @param {boolean} enabled
 * @param {number} hours
 * @param {number} now
 */
export function nextPublicAccess(enabled, hours, now) {
  if (hours !== 0 && hours !== 1 && hours !== 4 && hours !== 24) {
    throw new Error("Public access timer must be 1 hour, 4 hours, 24 hours, or left off.");
  }
  if (!enabled) return { enabled: false, offAt: null };
  if (hours === 0) return { enabled: true, offAt: null };
  return { enabled: true, offAt: now + hours * 60 * 60 * 1000 };
}

/**
 * @param {unknown} raw
 * @param {number} now
 */
export function settlePublicAccess(raw, now) {
  const enabled = Boolean(raw && typeof raw === "object" && raw.enabled === true);
  const offAt =
    raw && typeof raw === "object" && typeof raw.offAt === "number" && Number.isFinite(raw.offAt)
      ? raw.offAt
      : null;
  if (enabled && offAt != null && now >= offAt) return { enabled: false, offAt: null, expired: true };
  return { enabled, offAt: enabled ? offAt : null, expired: false };
}

/** @param {string} file @param {{ enabled: boolean, offAt: number | null }} state */
export function writePublicAccessFile(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  const body = JSON.stringify({ enabled: state.enabled === true, offAt: state.offAt ?? null });
  writeFileSync(file, body, "utf8");
}

/** @param {string} file @param {number} [now] */
export function readPublicAccessFile(file, now = Date.now()) {
  let raw = { enabled: false, offAt: null };
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { enabled: false, offAt: null };
  }
  const settled = settlePublicAccess(raw, now);
  if (settled.expired) writePublicAccessFile(file, { enabled: false, offAt: null });
  return { enabled: settled.enabled, offAt: settled.offAt };
}


export const REMOTE_ACCESS_MINUTES = [15, 60, 240, 1440];


/**
 * Public (non-Tailscale, non-loopback) writes are refused when remote access is read-only.
 */
export function publicWriteAllowed(mode, address, access, now) {
  if (isLoopbackAddress(address) || isTailnetAddress(address)) return true;
  if (requestReach(mode, address, access, now) === "deny") return false;
  return access?.mode !== "ro";
}

function extraAccess(raw) {
  const mode = raw && raw.mode === "ro" ? "ro" : raw && raw.mode === "rw" ? "rw" : "";
  const source = raw && (raw.source === "remote" || raw.source === "local") ? raw.source : "";
  const byMachineId = raw && typeof raw.byMachineId === "string" ? raw.byMachineId.slice(0, 64) : "";
  const byName = raw && typeof raw.byName === "string" ? raw.byName.slice(0, 80) : "";
  return { mode, source, byMachineId, byName };
}

export function nextRemoteAccess({ enabled, minutes, mode, now, source, byMachineId, byName }) {
  if (enabled && !REMOTE_ACCESS_MINUTES.includes(Number(minutes))) {
    throw new Error("Remote access must turn itself off after 15 minutes, 1 hour, 4 hours, or 24 hours.");
  }
  if (!enabled) {
    return { enabled: false, offAt: null, mode: "", source: "", byMachineId: "", byName: "" };
  }
  const accessMode = mode === "ro" ? "ro" : "rw";
  return {
    enabled: true,
    offAt: now + Number(minutes) * 60 * 1000,
    mode: accessMode,
    source: source === "remote" ? "remote" : "local",
    byMachineId: String(byMachineId || "").slice(0, 64),
    byName: String(byName || "").slice(0, 80),
  };
}

export function remoteAccessBanner(state, now = Date.now()) {
  if (!state || state.enabled !== true) return null;
  if (state.offAt != null && now >= state.offAt) return null;
  const remaining = state.offAt != null ? Math.max(0, state.offAt - now) : null;
  return {
    title: REMOTE_ACCESS_BANNER_TITLE,
    message: REMOTE_ACCESS_BANNER,
    mode: state.mode === "ro" ? "ro" : "rw",
    source: state.source || "",
    byName: state.byName || "",
    offAt: state.offAt,
    remainingMs: remaining,
  };
}

export function writeRemoteAccessFile(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  const body = { enabled: state.enabled === true, offAt: state.offAt ?? null };
  if (state.enabled && (state.mode === "ro" || state.mode === "rw")) body.mode = state.mode;
  if (state.enabled && state.source) body.source = state.source;
  if (state.enabled && state.byMachineId) body.byMachineId = state.byMachineId;
  if (state.enabled && state.byName) body.byName = state.byName;
  writeFileSync(file, JSON.stringify(body), "utf8");
}

export function readRemoteAccessFile(file, now = Date.now()) {
  let raw = { enabled: false, offAt: null };
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { enabled: false, offAt: null, mode: "", source: "", byMachineId: "", byName: "" };
  }
  const settled = settlePublicAccess(raw, now);
  const extra = extraAccess(raw);
  if (settled.expired) {
    writePublicAccessFile(file, { enabled: false, offAt: null });
    return { enabled: false, offAt: null, mode: "", source: "", byMachineId: "", byName: "" };
  }
  if (!settled.enabled) return { enabled: false, offAt: null, mode: "", source: "", byMachineId: "", byName: "" };
  return { enabled: true, offAt: settled.offAt, ...extra };
}
