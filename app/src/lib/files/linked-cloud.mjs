/**
 * Calls the Mesa and Moon cloud API.
 * The body is the sanitized connection record. This module never sends a
 * folder list, a password, a phone code, or a pair token.
 */

import os from "node:os";
import { isMountableHost } from "./phone-drive.mjs";
import {
  classifyAddresses,
  machineType,
  newMachineId,
  newMachineKeys,
  sanitizeRegistration,
} from "./linked-machines.mjs";
import {
  loadAccount,
  loadFirebaseConfig,
  loadIdentity,
  loadShares,
  machineHome,
  saveAccount,
  saveIdentity,
} from "./linked-store.mjs";

export async function verifyFirebaseIdToken(idToken, config, fetchImpl = fetch) {
  const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`;
  const res = await fetchImpl(url);
  if (!res.ok) return null;
  const info = await res.json();
  const aud = String(info.aud || "");
  if (aud !== config.projectId) return null;
  const uid = String(info.sub || info.user_id || "");
  if (!uid) return null;
  return { uid, email: String(info.email || ""), displayName: String(info.name || "") };
}

export async function refreshFirebase(config, refreshToken, fetchImpl = fetch) {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
  const res = await fetchImpl(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(config.apiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) return null;
  const info = await res.json();
  if (!info.id_token) return null;
  const expiresIn = Number(info.expires_in) || 3600;
  return {
    idToken: String(info.id_token),
    refreshToken: String(info.refresh_token || refreshToken),
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

export function localConnection(port, platform = process.platform) {
  const addresses = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.internal) continue;
      addresses.push(net.address);
    }
  }
  return {
    ...classifyAddresses(addresses),
    port: Number(port) || 8765,
    type: machineType(platform),
  };
}

export function ensureIdentity(home, displayName) {
  const existing = loadIdentity(home);
  if (existing?.machineId && existing.publicKey && existing.privateKey) {
    if (displayName && existing.displayName !== displayName) {
      return saveIdentity(home, { ...existing, displayName });
    }
    return existing;
  }
  const keys = newMachineKeys();
  return saveIdentity(home, {
    machineId: newMachineId(),
    displayName: displayName || os.hostname(),
    ...keys,
  });
}

export function registrationFor(home, port, now = new Date()) {
  const identity = ensureIdentity(home);
  const shares = loadShares(home);
  const local = localConnection(port);
  return sanitizeRegistration({
    machineId: identity.machineId,
    displayName: identity.displayName || os.hostname(),
    type: local.type,
    tailscaleHost: local.tailscaleHost,
    lanAddress: local.lanAddress,
    port: local.port,
    publicKey: identity.publicKey,
    lastSeen: now.toISOString(),
    hidden: shares.hidden,
    directInternet: shares.directInternet,
    publicHost: shares.publicHost,
  });
}

async function bearer(home, config, fetchImpl) {
  const account = loadAccount(home);
  if (!account?.idToken) return null;
  if (account.expiresAt && account.expiresAt > Date.now() + 60_000) return account;
  if (!account.refreshToken) return null;
  const next = await refreshFirebase(config, account.refreshToken, fetchImpl);
  if (!next) return null;
  return saveAccount(home, { ...account, ...next });
}

export async function pushThisMachine(home, port, fetchImpl = fetch) {
  const config = loadFirebaseConfig(home);
  if (!config?.ready) return { ok: false, error: "Mesa and Moon sign-in is not configured on this machine." };
  const account = await bearer(home, config, fetchImpl);
  if (!account) return { ok: false, error: "Sign in to Mesa and Moon on this machine first." };
  const record = registrationFor(home, port);
  if (!record.ok) return record;
  const res = await fetchImpl(`${config.cloudApi}/machines.php`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${account.idToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(record.machine),
  });
  if (!res.ok) return { ok: false, error: "The Mesa and Moon cloud did not accept this machine." };
  return { ok: true, machine: record.machine };
}

export async function fetchMachines(home, fetchImpl = fetch) {
  const config = loadFirebaseConfig(home);
  if (!config?.ready) return { ok: false, error: "Mesa and Moon sign-in is not configured on this machine.", machines: [] };
  const account = await bearer(home, config, fetchImpl);
  if (!account) return { ok: false, error: "Sign in to Mesa and Moon on this machine first.", machines: [] };
  const identity = loadIdentity(home);
  const self = identity?.machineId ? `?self=${encodeURIComponent(identity.machineId)}` : "";
  const res = await fetchImpl(`${config.cloudApi}/machines.php${self}`, {
    headers: { authorization: `Bearer ${account.idToken}` },
  });
  if (!res.ok) return { ok: false, error: "The Mesa and Moon cloud did not return machines.", machines: [] };
  const body = await res.json();
  const machines = Array.isArray(body.machines) ? body.machines : [];
  return { ok: true, machines, selfId: identity?.machineId || "" };
}

export function remoteIsPrivate(address) {
  return isMountableHost(address);
}

let heartbeatTimer = null;

export function startHeartbeat(env = process.env) {
  if (heartbeatTimer) return;
  const tick = () => {
    const home = machineHome(env);
    if (!home) return;
    const port = String(env.PORT || env.DRIVEBAY_PORT || "8765");
    void pushThisMachine(home, port).catch(() => {});
  };
  heartbeatTimer = setInterval(tick, 60_000);
  if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
  setTimeout(tick, 5_000).unref?.();
}
