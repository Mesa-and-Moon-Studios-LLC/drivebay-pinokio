/**
 * Local vault state and helpers for the encrypted machine directory.
 * The DEK stays on this machine (memory, plus a device wrap).
 * Passphrase, passkey, and recovery wraps are uploaded to the cloud API.
 */

import {
  buildEnvelope,
  CANNOT_RECOVER_MESSAGE,
  isLegacyPlaintext,
  migratePlaintextRows,
  newDek,
  newRecoveryKey,
  openEnvelope,
  publicWrap,
  unwrapWithDeviceKey,
  unwrapWithPassphrase,
  unwrapWithPrf,
  unwrapWithRecoveryKey,
  VAULT_VERSION,
  wrapWithDeviceKey,
  wrapWithPassphrase,
  wrapWithPrf,
  wrapWithRecoveryKey,
} from "./linked-crypto.mjs";
import fs from "node:fs";
import path from "node:path";
import { loadIdentity, writePrivate } from "./linked-store.mjs";

export { CANNOT_RECOVER_MESSAGE, VAULT_VERSION };

const vaultCache = new Map();

function vaultFile(home) {
  return home ? path.join(home, "mesa-vault.json") : "";
}

export function readVaultFile(home) {
  const file = vaultFile(home);
  if (!file) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function saveVaultFile(home, state) {
  const file = vaultFile(home);
  if (!file) return false;
  const next = {
    version: VAULT_VERSION,
    deviceWrap: state.deviceWrap || null,
    hasPassphrase: state.hasPassphrase === true,
    hasPasskey: state.hasPasskey === true,
    hasRecovery: state.hasRecovery === true,
    createdAt: state.createdAt || new Date().toISOString(),
  };
  writePrivate(file, next);
  return true;
}

export function publicVault(state, unlocked) {
  const has = Boolean(state?.deviceWrap || state?.hasPassphrase || state?.hasRecovery || state?.hasPasskey);
  return {
    ready: has,
    unlocked: Boolean(unlocked),
    hasPassphrase: Boolean(state?.hasPassphrase),
    hasPasskey: Boolean(state?.hasPasskey),
    hasRecovery: Boolean(state?.hasRecovery),
    cannotRecover: CANNOT_RECOVER_MESSAGE,
  };
}

function cacheKey(home) {
  return path.resolve(home || "");
}

export function rememberDek(home, dek) {
  if (!home || !dek) return;
  vaultCache.set(cacheKey(home), Buffer.from(dek));
}

export function forgetDek(home) {
  vaultCache.delete(cacheKey(home));
}

export function loadDek(home) {
  const cached = vaultCache.get(cacheKey(home));
  if (cached) return Buffer.from(cached);
  const state = readVaultFile(home);
  const identity = loadIdentity(home);
  if (!state?.deviceWrap || !identity?.privateKey) return null;
  try {
    const dek = unwrapWithDeviceKey(state.deviceWrap, identity.privateKey);
    rememberDek(home, dek);
    return dek;
  } catch {
    return null;
  }
}

export function setupVault(home, { passphrase, recoveryKey, prfOutput, credentialId, prfSalt } = {}) {
  const identity = loadIdentity(home);
  if (!identity?.privateKey || !identity.machineId) {
    return { ok: false, error: "This machine has not created its keys yet." };
  }
  if (!passphrase || String(passphrase).length < 8) {
    return { ok: false, error: "Set a recovery passphrase of at least 8 characters." };
  }
  const dek = newDek();
  const shownKey = recoveryKey || newRecoveryKey();
  const wraps = [wrapWithPassphrase(dek, passphrase), wrapWithRecoveryKey(dek, shownKey)];
  if (prfOutput) wraps.push(wrapWithPrf(dek, prfOutput, credentialId, prfSalt));
  const deviceWrap = wrapWithDeviceKey(dek, identity.privateKey, identity.machineId);
  saveVaultFile(home, {
    deviceWrap,
    hasPassphrase: true,
    hasPasskey: Boolean(prfOutput),
    hasRecovery: true,
    createdAt: new Date().toISOString(),
  });
  rememberDek(home, dek);
  return {
    ok: true,
    dek,
    wraps: wraps.map(publicWrap).filter(Boolean),
    recoveryKey: shownKey,
    message: CANNOT_RECOVER_MESSAGE,
  };
}

export function addPasskeyWrap(home, prfOutput, credentialId, prfSalt) {
  const dek = loadDek(home);
  if (!dek) return { ok: false, error: "Unlock the machine list on this device first." };
  const wrap = publicWrap(wrapWithPrf(dek, prfOutput, credentialId, prfSalt));
  const state = readVaultFile(home) || {};
  saveVaultFile(home, { ...state, hasPasskey: true });
  return { ok: true, wrap };
}

export function unlockWithSecret(home, { passphrase, recoveryKey, prfOutput, wrap } = {}) {
  if (!wrap) return { ok: false, error: "The unlock record is missing." };
  try {
    let dek;
    if (passphrase) dek = unwrapWithPassphrase(wrap, passphrase);
    else if (recoveryKey) dek = unwrapWithRecoveryKey(wrap, recoveryKey);
    else if (prfOutput) dek = unwrapWithPrf(wrap, prfOutput);
    else return { ok: false, error: "Enter the passphrase, the recovery key, or use a passkey." };
    const identity = loadIdentity(home);
    if (identity?.privateKey) {
      const state = readVaultFile(home) || {};
      saveVaultFile(home, {
        ...state,
        deviceWrap: wrapWithDeviceKey(dek, identity.privateKey, identity.machineId),
        hasPassphrase: state.hasPassphrase || wrap.kind === "passphrase",
        hasPasskey: state.hasPasskey || wrap.kind === "passkey",
        hasRecovery: state.hasRecovery || wrap.kind === "recovery",
      });
    }
    rememberDek(home, dek);
    return { ok: true, dek };
  } catch {
    return { ok: false, error: "That passphrase, passkey, or recovery key did not unlock the list." };
  }
}

export function envelopeFor(home, machine, dek = loadDek(home)) {
  if (!dek) return { ok: false, error: "Unlock the machine list on this device first." };
  return buildEnvelope(dek, machine);
}

export function openListedMachines(dek, payload) {
  const rows = Array.isArray(payload?.machines) ? payload.machines : [];
  const machines = [];
  const legacy = [];
  for (const row of rows) {
    if (isLegacyPlaintext(row)) {
      legacy.push(row);
      continue;
    }
    const opened = openEnvelope(dek, row);
    if (opened.ok) machines.push(opened.machine);
  }
  return { machines, legacy };
}

export function migrateLegacyList(dek, machines, now = new Date().toISOString()) {
  return migratePlaintextRows(dek, machines, now);
}

export function vaultStatus(home) {
  const state = readVaultFile(home);
  const dek = loadDek(home);
  return publicVault(state, Boolean(dek));
}

export { vaultFile };
