import fs from "node:fs";
import path from "node:path";

/** File name written by installer/windows/write-setup.ps1. UTF-8 JSON, no BOM. */
export const PENDING_ACCOUNT_FILE = "pending-account.json";

/**
 * Same place for the .exe installer, install.ps1, and the standalone server.
 * write-setup.ps1 stores it in the Drivebay home, next to the data folder:
 *   %LOCALAPPDATA%\Drivebay\pending-account.json
 * The server's DRIVEBAY_DATA_DIR is that home plus "data", so the parent is the home.
 * Pinokio does not write this file. Its data dir is the repo data folder, and
 * first run still shows create-account.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {typeof path} [pathApi]
 */
export function pendingAccountPath(env = process.env, pathApi = path) {
  const home = String(env.DRIVEBAY_HOME ?? "").trim();
  if (home) return pathApi.resolve(home, PENDING_ACCOUNT_FILE);
  const data = String(env.DRIVEBAY_DATA_DIR ?? "").trim();
  if (data) return pathApi.resolve(pathApi.dirname(pathApi.resolve(data)), PENDING_ACCOUNT_FILE);
  if (env.DRIVEBAY_PINOKIO === "true") {
    const cwd = String(env.DRIVEBAY_CWD ?? "").trim() || process.cwd();
    return pathApi.resolve(cwd, "..", PENDING_ACCOUNT_FILE);
  }
  const local = String(env.LOCALAPPDATA ?? "").trim();
  if (local) return pathApi.resolve(local, "Drivebay", PENDING_ACCOUNT_FILE);
  const cwd = String(env.DRIVEBAY_CWD ?? "").trim() || process.cwd();
  return pathApi.resolve(cwd, PENDING_ACCOUNT_FILE);
}

/**
 * @param {string} text
 * @returns {{ ok: true, username: string, password: string } | { ok: false, reason: string }}
 */
export function parsePendingAccount(text) {
  let json;
  try {
    json = JSON.parse(String(text).replace(/^\uFEFF/, ""));
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  const username = String(json?.username ?? "").trim();
  const password = String(json?.password ?? "");
  if (!username || password.length < 8) return { ok: false, reason: "invalid" };
  return { ok: true, username, password };
}

/**
 * @param {string} file
 * @param {Pick<typeof fs, "existsSync" | "readFileSync">} [fsApi]
 */
export function loadPendingAccount(file, fsApi = fs) {
  if (!fsApi.existsSync(file)) return null;
  try {
    return parsePendingAccount(fsApi.readFileSync(file, "utf8"));
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

/**
 * Create-account is only for a machine with no user and no setup file.
 * @param {{ userCount: number, pending: { ok: boolean } | null }} state
 * @returns {"unlock" | "create"}
 */
export function firstRunMode(state) {
  if (state.userCount > 0) return "unlock";
  if (state.pending?.ok) return "unlock";
  return "create";
}

/** @param {string} file */
export function shredFile(file) {
  try {
    const size = fs.statSync(file).size;
    fs.writeFileSync(file, Buffer.alloc(Math.max(size, 1)));
  } catch {
    /* already gone */
  }
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* already gone */
  }
}
