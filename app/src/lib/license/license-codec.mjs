/**
 * Drivebay license keys, purchase codes and activation receipts (format v1).
 * Same byte layout as server/cloud-api/lib/license_crypto.php and the Kotlin LicenseCodec.
 * Verification is offline and needs only an Ed25519 public key. node:crypto only, no dependencies.
 */
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign as edSign, verify as edVerify } from "node:crypto";

export const LICENSE_EPOCH = 1767225600; // 2026-01-01T00:00:00Z (seconds)
export const LIFETIME_UPDATES = 0xffff;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const EDITIONS = { 1: "pro", 2: "elite", 3: "enterprise" };
const LICENSE_DOMAIN = Buffer.from("DRIVEBAY-LICENSE-v1\0", "latin1");
const RECEIPT_DOMAIN = Buffer.from("DRIVEBAY-RECEIPT-v1\0", "latin1");
const DAY = 86400;

export function b32Encode(bytes) {
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5) out += ALPHABET[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  return out;
}

/** Tolerant: case-insensitive, I/L read as 1, O reads as 0, spaces and dashes ignored. Returns null on bad input. */
export function b32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[\s-]+/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  let bits = "";
  for (const ch of clean) {
    const pos = ALPHABET.indexOf(ch);
    if (pos < 0) return null;
    bits += pos.toString(2).padStart(5, "0");
  }
  const whole = Math.floor(bits.length / 8) * 8;
  if (whole < bits.length && /1/.test(bits.slice(whole))) return null;
  const out = Buffer.alloc(whole / 8);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return out;
}

const group = (text, size) => text.match(new RegExp(`.{1,${size}}`, "g")).join("-");
const dayFromTs = (ts) => Math.floor((ts - LICENSE_EPOCH) / DAY);
const tsFromDay = (day) => LICENSE_EPOCH + day * DAY;

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function publicKeyObject(hexOrBytes) {
  const raw = Buffer.isBuffer(hexOrBytes) ? hexOrBytes : Buffer.from(String(hexOrBytes), "hex");
  if (raw.length !== 32) throw new Error("Ed25519 public key must be 32 bytes");
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

function verifyDomain(domain, message, signature, publicKeys) {
  if (signature.length !== 64) return false;
  const data = Buffer.concat([domain, message]);
  for (const pk of publicKeys) {
    try {
      if (edVerify(null, data, publicKeyObject(pk), signature)) return true;
    } catch {
      /* try the next key */
    }
  }
  return false;
}

export function parsePayload(payload) {
  if (payload.length < 20 || payload[0] !== 1) return null;
  const edition = EDITIONS[payload[1]];
  if (!edition) return null;
  const labelLen = payload[19];
  if (labelLen > 48 || payload.length !== 20 + labelLen) return null;
  const expiresDay = payload.readUInt16BE(7);
  const updatesDay = payload.readUInt16BE(9);
  return {
    edition,
    seats: payload.readUInt16BE(2),
    offline: (payload[4] & 1) === 1,
    issued: tsFromDay(payload.readUInt16BE(5)),
    expires: expiresDay === 0 ? null : tsFromDay(expiresDay),
    updatesUntil: updatesDay === LIFETIME_UPDATES ? null : tsFromDay(updatesDay),
    id: payload.subarray(11, 19).toString("hex"),
    label: payload.subarray(20, 20 + labelLen).toString("utf8"),
  };
}

/**
 * Verify a license key string offline. Checks the signature only. Use licenseState() for expiry.
 * @param {string} keyText
 * @param {Array<string|Buffer>} publicKeys hex or raw Ed25519 public keys
 * @returns {{ ok: boolean, error: string, license: object | null }}
 */
export function verifyLicenseKey(keyText, publicKeys) {
  const text = String(keyText || "").trim();
  if (!/^DBAY/i.test(text)) return { ok: false, error: "format", license: null };
  const raw = b32Decode(text.slice(4));
  if (!raw || raw.length < 20 + 64) return { ok: false, error: "format", license: null };
  const payload = raw.subarray(0, raw.length - 64);
  const signature = raw.subarray(raw.length - 64);
  if (!verifyDomain(LICENSE_DOMAIN, payload, signature, publicKeys)) return { ok: false, error: "signature", license: null };
  const license = parsePayload(payload);
  return license ? { ok: true, error: "", license } : { ok: false, error: "format", license: null };
}

/** "active" | "expired" | "updates_ended" (buildTs in seconds is the app build time). */
export function licenseState(license, now, buildTs = null) {
  if (license.expires !== null && now >= license.expires + DAY) return "expired";
  if (buildTs !== null && license.updatesUntil !== null && buildTs > license.updatesUntil + DAY) return "updates_ended";
  return "active";
}

const machineHash = (machineId) => createHash("sha256").update(String(machineId)).digest().subarray(0, 8);

function b64urlDecode(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  return Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Verify an activation receipt for this machine at `now` (seconds). */
export function verifyReceipt(text, machineId, publicKeys, now) {
  if (!String(text || "").startsWith("DBAR1.")) return { ok: false, error: "format" };
  const raw = b64urlDecode(String(text).slice(6));
  if (!raw || raw.length !== 25 + 64) return { ok: false, error: "format" };
  const payload = raw.subarray(0, 25);
  const signature = raw.subarray(25);
  if (payload[0] !== 1 || !verifyDomain(RECEIPT_DOMAIN, payload, signature, publicKeys)) return { ok: false, error: "signature" };
  const licenseId = payload.subarray(1, 9).toString("hex");
  if (!payload.subarray(9, 17).equals(machineHash(machineId))) return { ok: false, error: "machine" };
  const issuedAt = payload.readUInt32BE(17);
  const validUntil = payload.readUInt32BE(21);
  if (now >= validUntil) return { ok: false, error: "receipt_expired", licenseId };
  return { ok: true, error: "", licenseId, issuedAt, validUntil };
}

/** Short purchase code check: DBAY-XXXX-XXXX-XXXX-XXXX with a check character. Returns the 16-char form or null. */
export function normalisePurchaseCode(text) {
  const upper = String(text || "").trim().toUpperCase();
  if (!upper.startsWith("DBAY")) return null;
  const rest = upper.slice(4).replace(/[\s-]+/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  if (rest.length !== 16 || [...rest].some((c) => ALPHABET.indexOf(c) < 0)) return null;
  return codeCheckChar(rest.slice(0, 15)) === rest[15] ? rest : null;
}

export function codeCheckChar(fifteen) {
  let sum = 0;
  for (let i = 0; i < 15; i++) sum += (ALPHABET.indexOf(fifteen[i]) + 1) * (i + 3);
  return ALPHABET[sum % 32];
}

/** "long" (license key), "code" (purchase code), or "" */
export function classifyInput(text) {
  const t = String(text || "").trim();
  if (!/^DBAY/i.test(t)) return "";
  if (normalisePurchaseCode(t)) return "code";
  const compact = t.replace(/[\s-]+/g, "");
  return compact.length > 60 ? "long" : "";
}

/** ---- Minting (admin CLI and tests only; the production signing key lives on the server) ---- */
function privateKeyObject(secretSeedHex) {
  const seed = Buffer.from(secretSeedHex, "hex");
  if (seed.length !== 32 && seed.length !== 64) throw new Error("Ed25519 secret must be a 32-byte seed or 64-byte key");
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed.subarray(0, 32)]), format: "der", type: "pkcs8" });
}

export function mintLicenseKey(f, secretHex) {
  const edition = Object.entries(EDITIONS).find(([, name]) => name === f.edition)?.[0];
  if (!edition) throw new Error("Unknown edition");
  const seats = Number(f.seats);
  if (!Number.isInteger(seats) || seats < 1 || seats > 65535) throw new Error("Seats must be 1 to 65535");
  const issuedDay = dayFromTs(f.issued);
  const expiresDay = f.expires == null ? 0 : dayFromTs(f.expires);
  const updatesDay = f.updatesUntil == null ? LIFETIME_UPDATES : dayFromTs(f.updatesUntil);
  if (issuedDay < 1 || issuedDay > 0xfffe || expiresDay < 0 || expiresDay > 0xfffe || updatesDay < 0 || updatesDay > 0xffff) {
    throw new Error("A date is out of range");
  }
  if (f.expires != null && expiresDay < issuedDay) throw new Error("Expiry is before the issue date");
  const id = f.id ? Buffer.from(f.id, "hex") : randomBytes(8);
  if (id.length !== 8) throw new Error("License id must be 16 hex characters");
  const label = Buffer.from(f.label || "", "utf8");
  if (label.length > 48) throw new Error("Label is longer than 48 bytes");
  const head = Buffer.alloc(19);
  head[0] = 1;
  head[1] = Number(edition);
  head.writeUInt16BE(seats, 2);
  head[4] = f.offline ? 1 : 0;
  head.writeUInt16BE(issuedDay, 5);
  head.writeUInt16BE(expiresDay, 7);
  head.writeUInt16BE(updatesDay, 9);
  id.copy(head, 11);
  const payload = Buffer.concat([head, Buffer.from([label.length]), label]);
  const signature = edSign(null, Buffer.concat([LICENSE_DOMAIN, payload]), privateKeyObject(f.secretHex || secretHex));
  return { key: `DBAY-${group(b32Encode(Buffer.concat([payload, signature])), 5)}`, license: parsePayload(payload) };
}

export function mintReceipt({ licenseId, machineId, issuedAt, validUntil }, secretHex) {
  const payload = Buffer.alloc(25);
  payload[0] = 1;
  Buffer.from(licenseId, "hex").copy(payload, 1);
  machineHash(machineId).copy(payload, 9);
  payload.writeUInt32BE(issuedAt, 17);
  payload.writeUInt32BE(validUntil, 21);
  const signature = edSign(null, Buffer.concat([RECEIPT_DOMAIN, payload]), privateKeyObject(secretHex));
  return `DBAR1.${Buffer.concat([payload, signature]).toString("base64url")}`;
}
