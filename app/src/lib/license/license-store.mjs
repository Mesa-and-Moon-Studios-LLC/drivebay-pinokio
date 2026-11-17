/**
 * Local license state: what is stored, how it is judged, and how it talks to the license server.
 *
 * license.json in the Drivebay data folder holds { key, receipt, lastCheckAt }. It is not a secret
 * (the key is useless to anyone else once seats are used) but it is written 0600 like the other files.
 * Judging a license is offline and needs only the embedded public keys.
 */
import fs from "node:fs";
import path from "node:path";
import {
  classifyInput,
  licenseState,
  verifyLicenseKey,
  verifyReceipt,
} from "./license-codec.mjs";
import { EDITION_NAMES, editionAllows, policyFor, remoteMinutesAllowed, sharedFolderLimit, upgradeMessage } from "./edition-policy.mjs";
import { LICENSE_API, LICENSE_PUBLIC_KEYS } from "./public-keys.mjs";

export const REFRESH_EVERY_SECONDS = 7 * 86400;

export function licenseFile(home) {
  return home ? path.join(home, "license.json") : "";
}

export function loadLicenseRecord(home) {
  try {
    const parsed = JSON.parse(fs.readFileSync(licenseFile(home), "utf8"));
    if (parsed && typeof parsed.key === "string") {
      return {
        key: parsed.key,
        receipt: typeof parsed.receipt === "string" ? parsed.receipt : "",
        lastCheckAt: Number(parsed.lastCheckAt) || 0,
        activatedAt: Number(parsed.activatedAt) || 0,
        lastError: typeof parsed.lastError === "string" ? parsed.lastError : "",
      };
    }
  } catch {
    /* none yet */
  }
  return null;
}

export function saveLicenseRecord(home, record) {
  const file = licenseFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.part`;
  fs.writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* some systems refuse chmod */
  }
}

export function clearLicenseRecord(home) {
  try {
    fs.rmSync(licenseFile(home), { force: true });
  } catch {
    /* already gone */
  }
}

/**
 * Enterprise self-host: a license file placed next to the data (license.dbaylicense) or named by
 * DRIVEBAY_LICENSE_FILE. It is read-only input; an offline-flagged key needs no activation.
 */
export function loadDropInLicense(home, env = process.env) {
  const candidates = [String(env.DRIVEBAY_LICENSE_FILE || "").trim(), home ? path.join(home, "license.dbaylicense") : ""].filter(Boolean);
  for (const file of candidates) {
    try {
      const key = extractKeyInput(fs.readFileSync(file, "utf8")).replace(/\s+/g, "");
      if (key) return { key, receipt: "", lastCheckAt: 0, activatedAt: 0, lastError: "", fromFile: file };
    } catch {
      /* not there */
    }
  }
  return null;
}

const verifyCache = new Map();
function verifyKeyCached(key, publicKeys) {
  const id = `${key}|${publicKeys.join(",")}`;
  if (!verifyCache.has(id)) {
    if (verifyCache.size > 64) verifyCache.clear();
    verifyCache.set(id, verifyLicenseKey(key, publicKeys));
  }
  return verifyCache.get(id);
}

/**
 * Judge the stored license. Pure: no disk, no network.
 * @param {{ key: string, receipt?: string, lastCheckAt?: number } | null} record
 * @param {{ machineId: string, now?: number, buildTs?: number | null, publicKeys?: string[] }} ctx now/buildTs in seconds
 */
export function evaluateLicense(record, ctx) {
  const now = ctx.now ?? Math.floor(Date.now() / 1000);
  const publicKeys = ctx.publicKeys ?? LICENSE_PUBLIC_KEYS;
  const base = {
    edition: "free",
    name: "Free",
    status: "none",
    detail: "",
    license: null,
    seats: 0,
    expires: null,
    updatesUntil: null,
    needsRefresh: false,
    receiptValidUntil: null,
  };
  if (!record || !record.key) return base;
  const checked = verifyKeyCached(record.key, publicKeys);
  if (!checked.ok) return { ...base, status: "invalid", detail: "The stored license did not verify, so Drivebay is running as Free." };
  const license = checked.license;
  const info = { ...base, license, seats: license.seats, expires: license.expires, updatesUntil: license.updatesUntil, declared: license.edition };
  const state = licenseState(license, now, ctx.buildTs ?? null);
  if (state === "expired") {
    return { ...info, status: "expired", detail: `Your ${EDITION_NAMES[license.edition]} license expired. Everything you own still works; Pro features are off until you renew.` };
  }
  if (state === "updates_ended") {
    return {
      ...info,
      status: "updates_ended",
      detail: "Your updates ended before this version was released. This build runs as Free. Renew updates, or install a version released before your updates ended.",
    };
  }
  if (!license.offline && record.lastError && ["revoked", "unknown_license", "unknown_code", "code_disabled"].includes(record.lastError)) {
    return { ...info, status: "revoked", detail: "This license was revoked, so Drivebay is running as Free. Write to support if you think that is a mistake." };
  }
  if (!license.offline) {
    const receipt = record.receipt ? verifyReceipt(record.receipt, ctx.machineId, publicKeys, now) : { ok: false, error: "missing" };
    if (!receipt.ok) {
      const error = receipt.error;
      return {
        ...info,
        status: "needs_online",
        needsRefresh: true,
        detail:
          error === "receipt_expired" || error === "missing"
            ? "Drivebay needs to check in with the license server. Connect to the internet and press Refresh."
            : "This license is not activated for this machine. Press Activate again.",
      };
    }
    info.receiptValidUntil = receipt.validUntil;
  }
  const dueAt = (record.lastCheckAt || 0) + REFRESH_EVERY_SECONDS;
  return {
    ...info,
    edition: license.edition,
    name: EDITION_NAMES[license.edition],
    status: "active",
    needsRefresh: !license.offline && now >= dueAt,
  };
}

/** Everything the gates need, from disk. Sync and cheap. */
export function readEntitlements(home, ctx = {}) {
  let machineId = ctx.machineId || "";
  if (!machineId) {
    try {
      machineId = JSON.parse(fs.readFileSync(path.join(home, "machine-identity.json"), "utf8")).machineId || "";
    } catch {
      machineId = "";
    }
  }
  const record = loadLicenseRecord(home) || loadDropInLicense(home);
  const state = evaluateLicense(record, { machineId, now: ctx.now, buildTs: ctx.buildTs, publicKeys: ctx.publicKeys });
  return makeEntitlements(state);
}

export function makeEntitlements(state) {
  const edition = state.edition;
  return {
    state,
    edition,
    can: (feature) => editionAllows(edition, feature),
    remoteMinutesAllowed: (minutes) => remoteMinutesAllowed(edition, minutes),
    sharedFolderLimit: () => sharedFolderLimit(edition),
    upgradeMessage: (feature) => upgradeMessage(feature, edition),
  };
}

/** What the settings page may see (never the key itself in full). */
export function publicLicenseView(state, record) {
  const key = record?.key || "";
  return {
    edition: state.edition,
    name: state.name,
    declaredEdition: state.declared || state.edition,
    status: state.status,
    detail: state.detail,
    seats: state.seats,
    expires: state.expires,
    updatesUntil: state.updatesUntil,
    offline: state.license?.offline === true,
    label: state.license?.label || "",
    receiptValidUntil: state.receiptValidUntil,
    needsRefresh: state.needsRefresh,
    keyHint: key ? `${key.slice(0, 9)}…${key.slice(-5)}` : "",
    policy: policyFor(state.edition),
  };
}

/** Pull the key out of a pasted code, a pasted key, or the text of a .dbaylicense file. */
export function extractKeyInput(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const line = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => /^key\s*:/i.test(l));
  if (line) return line.replace(/^key\s*:\s*/i, "").trim();
  const begin = raw.match(/-----BEGIN DRIVEBAY LICENSE-----([\s\S]*?)-----END DRIVEBAY LICENSE-----/);
  if (begin) return begin[1].split(/\r?\n/).map((l) => l.trim()).filter((l) => /^DBAY/i.test(l)).join("");
  return raw;
}

async function postLicense(action, body, { fetchImpl = fetch, api = LICENSE_API, version = "", timeoutMs = 10000 } = {}) {
  let response;
  try {
    response = await fetchImpl(`${api}?action=${action}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        // The host's firewall refuses browser-looking agents on POST, so say who we are.
        "user-agent": `Drivebay/${version || "app"} (license)`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, network: true, error: "Could not reach the license server. Check your connection and try again.", code: "network" };
  }
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!response.ok) return { ok: false, status: response.status, error: data.error || "The license server said no.", code: data.code || "", data };
  return { ok: true, data };
}

/**
 * Enter a purchase code, license key, or license file text.
 * Purchase codes and online keys go to the server. An offline-flagged key (air-gapped Enterprise) is checked locally only.
 */
export async function activateLicense(home, input, ctx) {
  const now = ctx.now ?? Math.floor(Date.now() / 1000);
  const publicKeys = ctx.publicKeys ?? LICENSE_PUBLIC_KEYS;
  const text = extractKeyInput(input);
  const kind = classifyInput(text);
  if (!kind) return { ok: false, error: "That does not look like a Drivebay purchase code (DBAY-XXXX-XXXX-XXXX-XXXX) or license key.", code: "format" };
  if (kind === "long") {
    const local = verifyLicenseKey(text, publicKeys);
    if (!local.ok) return { ok: false, error: "That license key did not verify. Check it for typos, or ask for a new one.", code: "bad_signature" };
    if (licenseState(local.license, now) === "expired") return { ok: false, error: "That license has expired.", code: "expired" };
    if (local.license.offline) {
      saveLicenseRecord(home, { key: text.replace(/\s+/g, ""), receipt: "", lastCheckAt: now, activatedAt: now });
      return { ok: true, offline: true, license: local.license };
    }
  }
  const sent = await postLicense(
    "activate",
    { key: text, machineId: ctx.machineId, name: ctx.name || "", platform: ctx.platform || "desktop", appVersion: ctx.version || "" },
    ctx,
  );
  if (!sent.ok) return { ok: false, error: sent.error, code: sent.code, devices: sent.data?.devices, seats: sent.data?.seats };
  const key = sent.data.licenseKey;
  const verified = verifyLicenseKey(key, publicKeys);
  const receipt = verifyReceipt(sent.data.receipt, ctx.machineId, publicKeys, now);
  if (!verified.ok || !receipt.ok) {
    return { ok: false, error: "The license server's answer did not verify, so it was not saved.", code: "bad_server_answer" };
  }
  saveLicenseRecord(home, { key, receipt: sent.data.receipt, lastCheckAt: now, activatedAt: now });
  return { ok: true, license: verified.license, seatsUsed: sent.data.license?.seatsUsed };
}

/** Renew the receipt. Network trouble keeps the current state. A revoked or unknown license is removed. */
export async function refreshLicense(home, ctx) {
  const record = loadLicenseRecord(home);
  if (!record) return { ok: false, error: "No license is stored.", code: "none" };
  const local = verifyLicenseKey(record.key, ctx.publicKeys ?? LICENSE_PUBLIC_KEYS);
  if (local.ok && local.license.offline) return { ok: true, offline: true };
  const now = ctx.now ?? Math.floor(Date.now() / 1000);
  const sent = await postLicense(
    "refresh",
    { key: record.key, machineId: ctx.machineId, name: ctx.name || "", platform: ctx.platform || "desktop", appVersion: ctx.version || "" },
    ctx,
  );
  if (!sent.ok) {
    if (sent.network) return { ok: false, network: true, error: sent.error, code: "network" };
    if (["revoked", "unknown_license", "unknown_code", "code_disabled", "expired"].includes(sent.code)) {
      // Keep the record but with no receipt, so the page can say why. Features turn off at once.
      saveLicenseRecord(home, { ...record, receipt: "", lastCheckAt: now, lastError: sent.code });
    }
    return { ok: false, error: sent.error, code: sent.code };
  }
  const receipt = verifyReceipt(sent.data.receipt, ctx.machineId, ctx.publicKeys ?? LICENSE_PUBLIC_KEYS, now);
  if (!receipt.ok) return { ok: false, error: "The license server's answer did not verify.", code: "bad_server_answer" };
  saveLicenseRecord(home, { key: record.key, receipt: sent.data.receipt, lastCheckAt: now, activatedAt: record.activatedAt || now });
  return { ok: true };
}

/** Give the seat back, then forget the license on this machine. force clears locally even if the server is unreachable. */
export async function deactivateLicense(home, ctx) {
  const record = loadLicenseRecord(home);
  if (!record) return { ok: true, released: false };
  const local = verifyLicenseKey(record.key, ctx.publicKeys ?? LICENSE_PUBLIC_KEYS);
  if (local.ok && local.license.offline) {
    clearLicenseRecord(home);
    return { ok: true, released: false, offline: true };
  }
  const sent = await postLicense("deactivate", { key: record.key, machineId: ctx.machineId }, ctx);
  if (sent.ok) {
    clearLicenseRecord(home);
    return { ok: true, released: sent.data.released === true };
  }
  if (ctx.force) {
    clearLicenseRecord(home);
    return { ok: true, released: false, warning: "The seat was not released on the server. It frees up on its own after 120 days, or write to support." };
  }
  return { ok: false, network: sent.network === true, error: sent.error, code: sent.code };
}
