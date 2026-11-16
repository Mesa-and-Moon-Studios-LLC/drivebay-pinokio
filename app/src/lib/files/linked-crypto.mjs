/**
 * Client-side crypto for the Mesa and Moon machine directory.
 * The cloud is only allowed to store ciphertext, nonces, KDF/PRF
 * parameters, and wrapped copies of the account DEK.
 * The DEK, private keys, and wrap secrets never go to the API.
 */

import crypto from "node:crypto";
import { argon2id } from "@noble/hashes/argon2.js";

export const VAULT_VERSION = 2;

export const ARGON2_PARAMS = Object.freeze({
  t: 2,
  m: 19456,
  p: 1,
  dkLen: 32,
  version: 0x13,
});

import { CANNOT_RECOVER_MESSAGE } from "./linked-copy.mjs";
export { CANNOT_RECOVER_MESSAGE };

export const DIRECTORY_FIELDS = Object.freeze([
  "displayName",
  "type",
  "tailscaleHost",
  "lanAddress",
  "port",
  "publicKey",
  "hidden",
  "directInternet",
  "publicHost",
]);

export const ENVELOPE_KEYS = Object.freeze(["machineId", "lastSeen", "ciphertext", "nonce", "envelopeVersion"]);

function b64(buf) {
  return Buffer.from(buf).toString("base64");
}

function fromB64(value) {
  const text = String(value || "");
  if (!text) throw new Error("Missing encoded value.");
  return Buffer.from(text, "base64");
}

function cleanText(value, max) {
  return String(value ?? "")
    .replace(/[\r\n\0]/g, " ")
    .trim()
    .slice(0, max);
}

export function newDek() {
  return crypto.randomBytes(32);
}

export function aesGcmEncrypt(key, plaintext) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { nonce: b64(nonce), ciphertext: b64(Buffer.concat([body, tag])) };
}

export function aesGcmDecrypt(key, nonceB64, ciphertextB64) {
  const nonce = fromB64(nonceB64);
  const packed = fromB64(ciphertextB64);
  if (packed.length < 17) throw new Error("Ciphertext is too short.");
  const tag = packed.subarray(packed.length - 16);
  const body = packed.subarray(0, packed.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

export function encryptDirectory(dek, fields) {
  const payload = {};
  for (const key of DIRECTORY_FIELDS) {
    payload[key] = fields[key];
  }
  return aesGcmEncrypt(dek, Buffer.from(JSON.stringify(payload), "utf8"));
}

export function decryptDirectory(dek, nonce, ciphertext) {
  const raw = JSON.parse(aesGcmDecrypt(dek, nonce, ciphertext).toString("utf8"));
  if (!raw || typeof raw !== "object") throw new Error("Directory payload is invalid.");
  return raw;
}

export function buildEnvelope(dek, machine) {
  const machineId = cleanText(machine.machineId, 64);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(machineId)) return { ok: false, error: "Machine id is invalid." };
  const lastSeen = cleanText(machine.lastSeen, 40);
  if (!Number.isFinite(Date.parse(lastSeen))) return { ok: false, error: "Last seen is invalid." };
  const sealed = encryptDirectory(dek, machine);
  return {
    ok: true,
    envelope: {
      machineId,
      lastSeen,
      ciphertext: sealed.ciphertext,
      nonce: sealed.nonce,
      envelopeVersion: VAULT_VERSION,
    },
  };
}

/**
 * Accept a cloud body only when it is a v2 envelope.
 * Secrets, folder lists, and plaintext connection fields are refused.
 */
export function sanitizeEnvelope(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Machine record is not an object." };
  }
  const extra = Object.keys(input).filter((key) => !ENVELOPE_KEYS.includes(key));
  if (extra.length) return { ok: false, error: "That record is not an encrypted machine directory." };
  const machineId = cleanText(input.machineId, 64);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(machineId)) return { ok: false, error: "Machine id is invalid." };
  const lastSeen = cleanText(input.lastSeen, 40);
  if (!Number.isFinite(Date.parse(lastSeen))) return { ok: false, error: "Last seen is invalid." };
  const ciphertext = String(input.ciphertext || "").trim();
  const nonce = String(input.nonce || "").trim();
  if (ciphertext.length < 24 || ciphertext.length > 32768) return { ok: false, error: "Ciphertext is invalid." };
  if (nonce.length < 8 || nonce.length > 64) return { ok: false, error: "Nonce is invalid." };
  const version = Number(input.envelopeVersion);
  if (version !== VAULT_VERSION) return { ok: false, error: "Envelope version is invalid." };
  return { ok: true, envelope: { machineId, lastSeen, ciphertext, nonce, envelopeVersion: VAULT_VERSION } };
}

export function isLegacyPlaintext(row) {
  if (!row || typeof row !== "object") return false;
  if (Number(row.envelopeVersion) === VAULT_VERSION && row.ciphertext) return false;
  return Boolean(row.publicKey || row.displayName || row.lanAddress || row.tailscaleHost);
}

export function openEnvelope(dek, envelope) {
  const clean = sanitizeEnvelope(envelope);
  if (!clean.ok) return clean;
  try {
    const fields = decryptDirectory(dek, clean.envelope.nonce, clean.envelope.ciphertext);
    return {
      ok: true,
      machine: {
        machineId: clean.envelope.machineId,
        lastSeen: clean.envelope.lastSeen,
        displayName: fields.displayName,
        type: fields.type,
        tailscaleHost: fields.tailscaleHost || "",
        lanAddress: fields.lanAddress || "",
        port: Number(fields.port) || 0,
        publicKey: fields.publicKey || "",
        hidden: fields.hidden === true,
        directInternet: fields.directInternet === true,
        publicHost: fields.publicHost || "",
      },
    };
  } catch {
    return { ok: false, error: "This machine list could not be unlocked." };
  }
}

export function derivePassphraseKey(passphrase, salt, params = ARGON2_PARAMS) {
  const pwd = String(passphrase ?? "");
  if (pwd.length < 8 || pwd.length > 256) throw new Error("Use a passphrase of at least 8 characters.");
  const saltBuf = Buffer.isBuffer(salt) ? salt : fromB64(salt);
  if (saltBuf.length < 16) throw new Error("Salt is too short.");
  const opts = {
    t: Number(params.t) || ARGON2_PARAMS.t,
    m: Number(params.m) || ARGON2_PARAMS.m,
    p: Number(params.p) || ARGON2_PARAMS.p,
    dkLen: Number(params.dkLen) || ARGON2_PARAMS.dkLen,
    version: Number(params.version) || ARGON2_PARAMS.version,
  };
  return Buffer.from(argon2id(pwd, saltBuf, opts));
}

export function wrapDek(dek, kek) {
  const sealed = aesGcmEncrypt(kek, dek);
  return { wrappedDek: sealed.ciphertext, nonce: sealed.nonce };
}

export function unwrapDek(kek, nonce, wrappedDek) {
  const opened = aesGcmDecrypt(kek, nonce, wrappedDek);
  if (opened.length !== 32) throw new Error("Unwrapped key is the wrong size.");
  return opened;
}

export function wrapWithPassphrase(dek, passphrase) {
  const salt = crypto.randomBytes(16);
  const kek = derivePassphraseKey(passphrase, salt);
  const wrapped = wrapDek(dek, kek);
  return {
    wrapId: crypto.randomUUID(),
    kind: "passphrase",
    alg: "argon2id-aes-256-gcm",
    salt: b64(salt),
    nonce: wrapped.nonce,
    wrappedDek: wrapped.wrappedDek,
    params: { ...ARGON2_PARAMS },
    credentialId: "",
  };
}

export function unwrapWithPassphrase(wrap, passphrase) {
  const kek = derivePassphraseKey(passphrase, wrap.salt, wrap.params || ARGON2_PARAMS);
  return unwrapDek(kek, wrap.nonce, wrap.wrappedDek);
}

const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ234567890";

export function newRecoveryKey() {
  const bytes = crypto.randomBytes(20);
  let out = "";
  for (const byte of bytes) out += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
  return out.match(/.{1,5}/g).join("-");
}

export function normalizeRecoveryKey(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
}

function recoveryKeyBytes(key) {
  const normalized = normalizeRecoveryKey(key);
  if (normalized.length < 20) throw new Error("That recovery key is not complete.");
  return crypto.createHash("sha256").update("drivebay-recovery-v1\0").update(normalized).digest();
}

export function wrapWithRecoveryKey(dek, recoveryKey) {
  const kek = recoveryKeyBytes(recoveryKey);
  const wrapped = wrapDek(dek, kek);
  return {
    wrapId: crypto.randomUUID(),
    kind: "recovery",
    alg: "sha256-aes-256-gcm",
    salt: "",
    nonce: wrapped.nonce,
    wrappedDek: wrapped.wrappedDek,
    params: { hash: "sha256", info: "drivebay-recovery-v1" },
    credentialId: "",
  };
}

export function unwrapWithRecoveryKey(wrap, recoveryKey) {
  return unwrapDek(recoveryKeyBytes(recoveryKey), wrap.nonce, wrap.wrappedDek);
}

export function prfKek(prfOutput, saltB64) {
  const ikm = Buffer.isBuffer(prfOutput) ? prfOutput : fromB64(prfOutput);
  const salt = saltB64 ? fromB64(saltB64) : Buffer.alloc(0);
  return Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("drivebay-prf-wrap-v1"), 32));
}

export function wrapWithPrf(dek, prfOutput, credentialId, evalSalt) {
  const salt = evalSalt ? fromB64(evalSalt) : crypto.randomBytes(32);
  const kek = prfKek(prfOutput, b64(salt));
  const wrapped = wrapDek(dek, kek);
  return {
    wrapId: crypto.randomUUID(),
    kind: "passkey",
    alg: "webauthn-prf-aes-256-gcm",
    salt: b64(salt),
    nonce: wrapped.nonce,
    wrappedDek: wrapped.wrappedDek,
    params: { ext: "prf", first: b64(salt) },
    credentialId: String(credentialId || ""),
  };
}

export function unwrapWithPrf(wrap, prfOutput) {
  const kek = prfKek(prfOutput, wrap.salt);
  return unwrapDek(kek, wrap.nonce, wrap.wrappedDek);
}

/** Device-local wrap so this machine can heartbeat after a restart without the passphrase. */
export function wrapWithDeviceKey(dek, privateKeyB64, machineId) {
  const ikm = fromB64(privateKeyB64);
  const salt = crypto.randomBytes(16);
  const kek = Buffer.from(
    crypto.hkdfSync("sha256", ikm, salt, Buffer.from(`drivebay-device-wrap-v1:${machineId}`), 32),
  );
  const wrapped = wrapDek(dek, kek);
  return {
    kind: "device",
    alg: "hkdf-sha256-aes-256-gcm",
    salt: b64(salt),
    nonce: wrapped.nonce,
    wrappedDek: wrapped.wrappedDek,
    machineId: String(machineId || ""),
  };
}

export function unwrapWithDeviceKey(wrap, privateKeyB64) {
  const ikm = fromB64(privateKeyB64);
  const kek = Buffer.from(
    crypto.hkdfSync(
      "sha256",
      ikm,
      fromB64(wrap.salt),
      Buffer.from(`drivebay-device-wrap-v1:${wrap.machineId || ""}`),
      32,
    ),
  );
  return unwrapDek(kek, wrap.nonce, wrap.wrappedDek);
}

export function publicWrap(wrap) {
  if (!wrap || typeof wrap !== "object") return null;
  const kind = String(wrap.kind || "");
  if (!["passphrase", "passkey", "recovery"].includes(kind)) return null;
  return {
    wrapId: String(wrap.wrapId || ""),
    kind,
    alg: String(wrap.alg || ""),
    salt: String(wrap.salt || ""),
    nonce: String(wrap.nonce || ""),
    wrappedDek: String(wrap.wrappedDek || ""),
    params: wrap.params && typeof wrap.params === "object" ? wrap.params : {},
    credentialId: String(wrap.credentialId || ""),
  };
}

export function newPrfSalt() {
  return b64(crypto.randomBytes(32));
}

export function migratePlaintextRows(dek, rows, nowIso) {
  const envelopes = [];
  const leftover = [];
  for (const row of rows || []) {
    if (!row) continue;
    if (!isLegacyPlaintext(row) && row.ciphertext) {
      leftover.push(row);
      continue;
    }
    const built = buildEnvelope(dek, {
      ...row,
      lastSeen: row.lastSeen || nowIso,
    });
    if (!built.ok) return { ok: false, error: built.error };
    envelopes.push(built.envelope);
  }
  return { ok: true, envelopes, leftover };
}
