/**
 * Local files for the Mesa and Moon login.
 * Pair tokens and the Firebase refresh token stay in this directory.
 * They are never sent to the cloud API.
 */

import fs from "node:fs";
import path from "node:path";
import { freshPairState, normalizeShares } from "./linked-machines.mjs";

export function machineHome(env = process.env) {
  const home = String(env.DRIVEBAY_HOME || env.DRIVEBAY_DATA_DIR || "").trim();
  return home ? path.resolve(home) : "";
}

function fileIn(home, name) {
  if (!home) return "";
  return path.join(home, name);
}

export function writePrivate(file, value) {
  if (!file) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.part`;
  fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* some systems refuse chmod */
  }
  return true;
}

function readJson(file, fallback) {
  if (!file) return fallback;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function firebaseConfigPath(home) {
  return fileIn(home, "mesa-firebase.json");
}

export function loadFirebaseConfig(home) {
  const parsed = readJson(firebaseConfigPath(home), null);
  if (!parsed) return null;
  const config = {
    apiKey: String(parsed.apiKey || "").trim(),
    authDomain: String(parsed.authDomain || "").trim(),
    projectId: String(parsed.projectId || "").trim(),
    googleClientId: String(parsed.googleClientId || "").trim(),
    appleClientId: String(parsed.appleClientId || "").trim(),
    cloudApi: String(parsed.cloudApi || "").trim().replace(/\/$/, ""),
  };
  if (!config.apiKey || !config.projectId || !config.cloudApi) return { ...config, ready: false };
  if (!config.googleClientId && !config.appleClientId) return { ...config, ready: false };
  return { ...config, ready: true };
}

export function publicFirebaseConfig(config) {
  if (!config) return { ready: false, google: false, apple: false, authDomain: "" };
  return {
    ready: config.ready === true,
    google: Boolean(config.googleClientId),
    apple: Boolean(config.appleClientId),
    authDomain: config.authDomain || "",
    projectId: config.projectId || "",
    apiKey: config.apiKey || "",
    googleClientId: config.googleClientId || "",
    appleClientId: config.appleClientId || "",
  };
}

export function loadAccount(home) {
  return readJson(fileIn(home, "mesa-account.json"), null);
}

export function saveAccount(home, account) {
  const next = {
    uid: String(account.uid || ""),
    email: String(account.email || ""),
    displayName: String(account.displayName || ""),
    idToken: String(account.idToken || ""),
    refreshToken: String(account.refreshToken || ""),
    expiresAt: Number(account.expiresAt) || 0,
  };
  writePrivate(fileIn(home, "mesa-account.json"), next);
  return next;
}

export function clearAccount(home) {
  const file = fileIn(home, "mesa-account.json");
  if (file && fs.existsSync(file)) fs.rmSync(file, { force: true });
}

export function loadIdentity(home) {
  return readJson(fileIn(home, "machine-identity.json"), null);
}

export function saveIdentity(home, identity) {
  writePrivate(fileIn(home, "machine-identity.json"), identity);
  return identity;
}

export function loadShares(home) {
  return normalizeShares(readJson(fileIn(home, "shared-folders.json"), {}));
}

export function saveShares(home, shares) {
  const next = normalizeShares(shares);
  writePrivate(fileIn(home, "shared-folders.json"), next);
  return next;
}

export function loadPairState(home) {
  const parsed = readJson(fileIn(home, "pair-state.json"), null);
  if (!parsed) return freshPairState();
  return {
    code: parsed.code || null,
    grants: parsed.grants && typeof parsed.grants === "object" ? parsed.grants : {},
    pending: Array.isArray(parsed.pending) ? parsed.pending : [],
  };
}

export function savePairState(home, state) {
  writePrivate(fileIn(home, "pair-state.json"), state);
  return state;
}

export function loadLinkedTokens(home) {
  const parsed = readJson(fileIn(home, "linked-tokens.json"), {});
  return parsed && !Array.isArray(parsed) ? parsed : {};
}

export function saveLinkedTokens(home, records) {
  writePrivate(fileIn(home, "linked-tokens.json"), records);
  return records;
}

/** Fields the settings page may see. Tokens stay in the file. */
export function publicAccount(account) {
  if (!account?.uid) return { signedIn: false, email: "", displayName: "", uid: "" };
  return {
    signedIn: true,
    email: account.email || "",
    displayName: account.displayName || "",
    uid: account.uid,
  };
}

export function publicLinks(records) {
  return Object.entries(records || {}).map(([machineId, row]) => ({
    machineId,
    url: row?.url ? String(row.url) : "",
    label: row?.label ? String(row.label) : "",
    letter: row?.letter ? String(row.letter) : "",
    via: row?.via ? String(row.via) : "",
    paired: Boolean(row?.token),
  }));
}
