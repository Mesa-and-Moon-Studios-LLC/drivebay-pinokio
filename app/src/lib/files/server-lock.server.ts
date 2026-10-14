/**
 * Server-lock policy for Drivebay.
 *
 * File lives on the host only:
 *   <dataDir>/server-lock.json
 *
 * Settings on this PC (a signed-in loopback request) can write the file.
 * The process reads the file on every check, so a save applies immediately.
 * Web and APK clients on LAN or Tailscale can read the policy and cannot write it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveDataDir } from "./settings.server";

export type ServerLockPolicy = {
  /** Schema version for future migrations */
  version: 1;
  /** When false, Settings UI cannot change port (savePortSettings rejects). */
  allowPortChangeFromUi: boolean;
  /** When false, delete is blocked server-side. */
  allowDelete: boolean;
  /** When false, rename is blocked server-side. */
  allowRename: boolean;
  /** When false, create folder is blocked server-side. */
  allowCreateFolder: boolean;
  /** When false, upload is blocked server-side. */
  allowUpload: boolean;
  /** Hard upload ceiling in MB (server enforces; UI should display). */
  maxUploadMb: number;
  /**
   * Optional drive root allow-list (Windows paths like "X:\\", "Z:\\", "C:\\Users\\...").
   * Empty array = all discovered drives (default).
   */
  allowedRoots: string[];
  /** Optional note shown read-only in Settings (for you). */
  note: string;
};

export type PublicServerLock = {
  allowPortChangeFromUi: boolean;
  allowDelete: boolean;
  allowRename: boolean;
  allowCreateFolder: boolean;
  allowUpload: boolean;
  maxUploadMb: number;
  allowedRoots: string[];
  note: string;
  /** True when this request is not the host PC, so Settings stays read-only. */
  lockedOnServer: boolean;
  /** True only for a loopback request. The write API checks this again. */
  canEdit: boolean;
  /** Absolute path of the lock file (for host admin reference in Settings). */
  lockFile: string;
};

const DEFAULTS: ServerLockPolicy = {
  version: 1,
  allowPortChangeFromUi: true,
  allowDelete: true,
  allowRename: true,
  allowCreateFolder: true,
  allowUpload: true,
  maxUploadMb: 512,
  allowedRoots: [],
  note: "",
};

export function resolveServerLockFile(): string {
  const fromEnv = process.env.DRIVEBAY_SERVER_LOCK_FILE?.trim();
  if (fromEnv) return resolve(fromEnv);
  return resolve(resolveDataDir(), "server-lock.json");
}

function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(v)));
}

function asBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === "boolean") return v;
  return fallback;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.trim());
}

export function normalizePolicy(raw: Partial<ServerLockPolicy> | null | undefined): ServerLockPolicy {
  const src = raw ?? {};
  return {
    version: 1,
    allowPortChangeFromUi: asBool(src.allowPortChangeFromUi, DEFAULTS.allowPortChangeFromUi),
    allowDelete: asBool(src.allowDelete, DEFAULTS.allowDelete),
    allowRename: asBool(src.allowRename, DEFAULTS.allowRename),
    allowCreateFolder: asBool(src.allowCreateFolder, DEFAULTS.allowCreateFolder),
    allowUpload: asBool(src.allowUpload, DEFAULTS.allowUpload),
    maxUploadMb: clampInt(src.maxUploadMb, 1, 8 * 1024, DEFAULTS.maxUploadMb),
    allowedRoots: asStringArray(src.allowedRoots),
    note: typeof src.note === "string" ? src.note.slice(0, 500) : "",
  };
}

/** Ensure the lock file exists with defaults (never overwrites a real policy). */
export function ensureServerLockFile(): string {
  const file = resolveServerLockFile();
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    const body = {
      ...DEFAULTS,
      note: "Edit this file on the PC only. Restart Drivebay after changes. Not writable from web/app.",
      _help: {
        allowPortChangeFromUi: "false = hide/block port changes in Settings UI",
        allowDelete: "false = block delete API",
        allowRename: "false = block rename API",
        allowCreateFolder: "false = block mkdir API",
        allowUpload: "false = block upload API",
        maxUploadMb: "hard ceiling for uploads (MB)",
        allowedRoots: 'e.g. ["X:\\\\","Z:\\\\","C:\\\\Users\\\\aaron_p0gli1k\\\\Downloads"] — empty = all drives',
      },
    };
    writeFileSync(file, JSON.stringify(body, null, 2) + "\n", "utf8");
  }
  return file;
}

export function readServerLock(): ServerLockPolicy {
  const file = ensureServerLockFile();
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<ServerLockPolicy>;
    return normalizePolicy(raw);
  } catch {
    return { ...DEFAULTS };
  }
}

export function toPublicServerLock(
  policy: ServerLockPolicy = readServerLock(),
  canEdit = false,
): PublicServerLock {
  return {
    allowPortChangeFromUi: policy.allowPortChangeFromUi,
    allowDelete: policy.allowDelete,
    allowRename: policy.allowRename,
    allowCreateFolder: policy.allowCreateFolder,
    allowUpload: policy.allowUpload,
    maxUploadMb: policy.maxUploadMb,
    allowedRoots: [...policy.allowedRoots],
    note: policy.note,
    lockedOnServer: !canEdit,
    canEdit,
    lockFile: resolveServerLockFile(),
  };
}

function samePolicy(a: ServerLockPolicy, b: ServerLockPolicy): boolean {
  if (a.allowPortChangeFromUi !== b.allowPortChangeFromUi) return false;
  if (a.allowDelete !== b.allowDelete) return false;
  if (a.allowRename !== b.allowRename) return false;
  if (a.allowCreateFolder !== b.allowCreateFolder) return false;
  if (a.allowUpload !== b.allowUpload) return false;
  if (a.maxUploadMb !== b.maxUploadMb) return false;
  if (a.allowedRoots.length !== b.allowedRoots.length) return false;
  return a.allowedRoots.every((root, i) => root === b.allowedRoots[i]);
}

/** Write UTF-8 JSON with no BOM. The next policy read in this process sees it. */
export function writeServerLock(
  input: Partial<ServerLockPolicy>,
): { policy: ServerLockPolicy; applied: "live" | "restart" } {
  const current = readServerLock();
  const next = normalizePolicy({ ...current, ...input, note: input.note ?? current.note });
  const file = resolveServerLockFile();
  mkdirSync(dirname(file), { recursive: true });
  const body = JSON.stringify(next, null, 2) + "\n";
  writeFileSync(file, body, "utf8");
  const back = readServerLock();
  return { policy: back, applied: samePolicy(next, back) ? "live" : "restart" };
}

export function assertPolicy(action: keyof Pick<
  ServerLockPolicy,
  "allowDelete" | "allowRename" | "allowCreateFolder" | "allowUpload" | "allowPortChangeFromUi"
>): void {
  const p = readServerLock();
  if (!p[action]) {
    throw new Error("This action is turned off in Settings on the PC that runs Drivebay.");
  }
}

export function assertUploadSize(bytes: number): void {
  const p = readServerLock();
  const max = p.maxUploadMb * 1024 * 1024;
  if (bytes > max) {
    throw new Error(`File is larger than ${p.maxUploadMb} MB (server-lock ceiling)`);
  }
}

/** Normalize Windows roots for comparison. */
export function normalizeRoot(p: string): string {
  let s = p.replace(/\//g, "\\").trim();
  if (/^[a-zA-Z]:$/.test(s)) s = s + "\\";
  if (/^[a-zA-Z]:\\$/.test(s)) return s.toUpperCase();
  // strip trailing slashes except drive root
  while (s.length > 3 && s.endsWith("\\")) s = s.slice(0, -1);
  return s;
}

export function isPathAllowedByRoots(resolvedPath: string, roots: string[] = readServerLock().allowedRoots): boolean {
  if (!roots.length) return true;
  const target = normalizeRoot(resolvedPath).toLowerCase();
  return roots.some((r) => {
    const root = normalizeRoot(r).toLowerCase();
    return target === root || target.startsWith(root.endsWith("\\") ? root : root + "\\");
  });
}

export function assertPathAllowed(resolvedPath: string): void {
  if (!isPathAllowedByRoots(resolvedPath)) {
    throw new Error("Path is outside allowedRoots (server-lock policy).");
  }
}
