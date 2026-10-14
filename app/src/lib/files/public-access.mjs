/**
 * Tailscale + Local (Both) keeps Tailscale open.
 * The router path is Public access, and it starts off.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isLoopbackAddress } from "./loopback.mjs";
import { isTailnetAddress } from "./tailnet.mjs";

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
