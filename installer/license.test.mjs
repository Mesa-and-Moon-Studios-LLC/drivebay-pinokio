import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  b32Decode,
  b32Encode,
  classifyInput,
  licenseState,
  mintLicenseKey,
  mintReceipt,
  normalisePurchaseCode,
  verifyLicenseKey,
  verifyReceipt,
} from "../app/src/lib/license/license-codec.mjs";
import {
  EDITION_ORDER,
  editionAllows,
  remoteMinutesAllowed,
  sharedFolderLimit,
  upgradeMessage,
} from "../app/src/lib/license/edition-policy.mjs";
import {
  activateLicense,
  clearLicenseRecord,
  deactivateLicense,
  evaluateLicense,
  extractKeyInput,
  loadDropInLicense,
  loadLicenseRecord,
  readEntitlements,
  refreshLicense,
  saveLicenseRecord,
} from "../app/src/lib/license/license-store.mjs";
import { LICENSE_PUBLIC_KEYS } from "../app/src/lib/license/public-keys.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(fs.readFileSync(path.join(here, "..", "docs", "license-test-vectors.json"), "utf8"));
const PK = [vectors.publicKeyHex];
const DAY = 86400;
const NOW = vectors.issued;
// A second, local test key pair for minting in JS. The seed is a test value only.
const SEED = Buffer.from("js-license-test-seed-not-for-prod".padEnd(32, "_").slice(0, 32)).toString("hex");
import { createPrivateKey, createPublicKey } from "node:crypto";
const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const jsPublicHex = createPublicKey(createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(SEED, "hex")]), format: "der", type: "pkcs8" }))
  .export({ format: "der", type: "spki" })
  .subarray(-32)
  .toString("hex");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dbay-lic-"));
}

test("server-signed test vectors verify offline and decode to the same fields", () => {
  for (const v of vectors.licenses) {
    const out = verifyLicenseKey(v.key, PK);
    assert.equal(out.ok, true, v.name);
    assert.deepEqual(out.license, v.expect, v.name);
  }
});

test("vectors: tampered keys are rejected", () => {
  for (const v of vectors.tamperedKeys) assert.equal(verifyLicenseKey(v.key, PK).ok, false, v.name);
});

test("a key does not verify under a different public key", () => {
  assert.equal(verifyLicenseKey(vectors.licenses[0].key, [jsPublicHex]).ok, false);
  assert.equal(verifyLicenseKey(vectors.licenses[0].key, [jsPublicHex, ...PK]).ok, true, "second key in the list is tried");
});

test("the embedded production public key is a 32-byte hex string", () => {
  assert.equal(LICENSE_PUBLIC_KEYS.length >= 1, true);
  for (const k of LICENSE_PUBLIC_KEYS) assert.match(k, /^[0-9a-f]{64}$/);
});

test("vectors: receipt verifies for its machine only and expires", () => {
  const r = vectors.receipt;
  assert.equal(verifyReceipt(r.text, r.machineId, PK, r.issuedAt + 10).ok, true);
  assert.equal(verifyReceipt(r.text, r.otherMachineId, PK, r.issuedAt + 10).error, "machine");
  assert.equal(verifyReceipt(r.text, r.machineId, PK, r.validUntil + 1).error, "receipt_expired");
  assert.equal(verifyReceipt(r.text.slice(0, -3) + "AAA", r.machineId, PK, r.issuedAt + 10).ok, false);
});

test("vectors: purchase code check character", () => {
  for (const c of vectors.purchaseCodes) assert.equal(normalisePurchaseCode(c.code) !== null, c.valid, c.code);
});

test("JS minting round trip, lowercase and spaces accepted, base32 tolerant of look-alikes", () => {
  const { key, license } = mintLicenseKey(
    { edition: "elite", seats: 10, issued: NOW, expires: null, updatesUntil: NOW + 2 * 365 * DAY, offline: false, label: "" },
    SEED,
  );
  assert.match(key, /^DBAY(-[0-9A-HJKMNP-TV-Z]{1,5})+$/);
  assert.equal(verifyLicenseKey(key, [jsPublicHex]).ok, true);
  assert.equal(verifyLicenseKey(key.toLowerCase().replace(/-/g, " "), [jsPublicHex]).ok, true);
  assert.deepEqual(verifyLicenseKey(key, [jsPublicHex]).license, license);
  assert.deepEqual(b32Decode(b32Encode(Buffer.from([1, 2, 3, 250, 251]))), Buffer.from([1, 2, 3, 250, 251]));
  assert.deepEqual(b32Decode("O0"), b32Decode("00"));
  assert.deepEqual(b32Decode("L0"), b32Decode("10"));
  assert.deepEqual(b32Decode("i0"), b32Decode("10"));
});

test("tamper rejection: edition, seats, expiry, label and signature edits all fail", () => {
  const { key } = mintLicenseKey(
    { edition: "pro", seats: 3, issued: NOW, expires: NOW + 365 * DAY, updatesUntil: NOW + 365 * DAY, offline: false, label: "Acme" },
    SEED,
  );
  const raw = b32Decode(key.slice(4));
  const reencode = (buf) => `DBAY-${b32Encode(buf).match(/.{1,5}/g).join("-")}`;
  const edit = (index, value) => {
    const copy = Buffer.from(raw);
    copy[index] = value;
    return reencode(copy);
  };
  assert.equal(verifyLicenseKey(key, [jsPublicHex]).ok, true);
  assert.equal(verifyLicenseKey(edit(1, 3), [jsPublicHex]).ok, false, "edition");
  assert.equal(verifyLicenseKey(edit(3, 200), [jsPublicHex]).ok, false, "seats");
  assert.equal(verifyLicenseKey(edit(8, 0xff), [jsPublicHex]).ok, false, "expiry");
  assert.equal(verifyLicenseKey(edit(20, 0x41 ^ 1), [jsPublicHex]).ok, false, "label");
  assert.equal(verifyLicenseKey(edit(raw.length - 1, raw[raw.length - 1] ^ 1), [jsPublicHex]).ok, false, "signature");
  assert.equal(verifyLicenseKey(reencode(raw.subarray(0, raw.length - 1)), [jsPublicHex]).ok, false, "truncated");
});

test("expiry and updates-until windows", () => {
  const sub = verifyLicenseKey(vectors.licenses[1].key, PK).license; // elite, 365 days
  assert.equal(licenseState(sub, NOW + 100 * DAY), "active");
  assert.equal(licenseState(sub, NOW + 400 * DAY), "expired");
  const perpetual = verifyLicenseKey(vectors.licenses[0].key, PK).license; // pro perpetual, updates 365 days
  assert.equal(licenseState(perpetual, NOW + 5000 * DAY), "active", "perpetual never expires");
  assert.equal(licenseState(perpetual, NOW + 500 * DAY, NOW + 100 * DAY), "active", "build inside the updates window");
  assert.equal(licenseState(perpetual, NOW + 500 * DAY, NOW + 400 * DAY), "updates_ended", "build after the updates window");
  const lifetime = verifyLicenseKey(vectors.licenses[2].key, PK).license;
  assert.equal(licenseState(lifetime, NOW + 9000 * DAY, NOW + 9000 * DAY), "active", "lifetime updates");
});

test("policy: free keeps own-machine linking; remote access is Pro+, 24h is Elite+", () => {
  assert.deepEqual(EDITION_ORDER, ["free", "pro", "elite", "enterprise"]);
  assert.equal(editionAllows("free", "remote_access"), false);
  assert.equal(editionAllows("free", "public_access"), false);
  assert.equal(editionAllows("pro", "remote_access"), true);
  assert.equal(editionAllows("pro", "remote_24h"), false);
  assert.equal(editionAllows("elite", "remote_24h"), true);
  assert.equal(editionAllows("enterprise", "remote_24h"), true);
  assert.equal(remoteMinutesAllowed("pro", 240), true);
  assert.equal(remoteMinutesAllowed("pro", 1440), false);
  assert.equal(sharedFolderLimit("free"), 3);
  assert.equal(sharedFolderLimit("elite"), -1);
  assert.match(upgradeMessage("remote_access"), /own machines still link/);
  assert.equal(editionAllows("nonsense", "remote_access"), false);
});

const ctxFor = (machineId, extra = {}) => ({ machineId, now: NOW + 5, buildTs: NOW, publicKeys: PK, ...extra });

test("evaluateLicense: no key is Free; a good online license needs a receipt for this machine", () => {
  assert.equal(evaluateLicense(null, ctxFor("m1")).edition, "free");
  const key = vectors.licenses[0].key;
  const noReceipt = evaluateLicense({ key, receipt: "" }, ctxFor("m1"));
  assert.equal(noReceipt.edition, "free");
  assert.equal(noReceipt.status, "needs_online");
  const good = evaluateLicense({ key, receipt: vectors.receipt.text, lastCheckAt: NOW }, ctxFor(vectors.receipt.machineId));
  assert.equal(good.edition, "pro");
  assert.equal(good.status, "active");
  const wrongMachine = evaluateLicense({ key, receipt: vectors.receipt.text }, ctxFor("some-other-machine"));
  assert.equal(wrongMachine.edition, "free", "a receipt cannot be copied to another machine");
  const forged = evaluateLicense({ key: "DBAY-NOPE", receipt: "" }, ctxFor("m1"));
  assert.equal(forged.status, "invalid");
  assert.equal(forged.edition, "free");
});

test("evaluateLicense: an offline license file needs no receipt; expiry and updates-ended fall back to Free", () => {
  const enterprise = vectors.licenses[2].key;
  const ok = evaluateLicense({ key: enterprise }, ctxFor("any-machine-1"));
  assert.equal(ok.edition, "enterprise");
  assert.equal(ok.license.label, "Acme Ünïcode GmbH");
  const sub = vectors.licenses[1].key;
  const lapsed = evaluateLicense({ key: sub, receipt: "" }, ctxFor("m1", { now: NOW + 500 * DAY }));
  assert.equal(lapsed.status, "expired");
  assert.equal(lapsed.edition, "free");
  const perpetual = vectors.licenses[0].key;
  const old = evaluateLicense({ key: perpetual, receipt: vectors.receipt.text }, ctxFor(vectors.receipt.machineId, { buildTs: NOW + 700 * DAY }));
  assert.equal(old.status, "updates_ended");
  assert.equal(old.edition, "free");
  assert.match(old.detail, /released before your updates ended/);
});

test("evaluateLicense: a revoked marker turns features off", () => {
  const out = evaluateLicense({ key: vectors.licenses[0].key, receipt: "", lastError: "revoked" }, ctxFor("m1"));
  assert.equal(out.status, "revoked");
  assert.equal(out.edition, "free");
});

test("license file text and drop-in file are understood", () => {
  const enterprise = vectors.licenses[2].key;
  const file = `-----BEGIN DRIVEBAY LICENSE-----\nLicensee: Acme\nEdition: enterprise\nKey: ${enterprise}\n-----END DRIVEBAY LICENSE-----\n`;
  assert.equal(extractKeyInput(file), enterprise);
  assert.equal(extractKeyInput(`  ${enterprise}  `), enterprise);
  assert.equal(classifyInput(enterprise), "long");
  assert.equal(classifyInput(vectors.purchaseCodes[0].code), "code");
  assert.equal(classifyInput("hello"), "");
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "license.dbaylicense"), file);
  const record = loadDropInLicense(dir, {});
  assert.equal(record.key, enterprise);
  const home2 = tmp();
  fs.writeFileSync(path.join(home2, "machine-identity.json"), JSON.stringify({ machineId: "host-machine-01" }));
  fs.writeFileSync(path.join(home2, "license.dbaylicense"), file);
  const ent = readEntitlements(home2, { publicKeys: PK, now: NOW + 5, buildTs: NOW });
  assert.equal(ent.edition, "enterprise");
  assert.equal(ent.can("remote_access"), true);
  assert.equal(readEntitlements(tmp(), { publicKeys: PK }).can("remote_access"), false, "no license: Free");
});

// A tiny fake license server so the client logic is tested without PHP. The PHP rules have their own tests.
function fakeServer({ seats = 2, secret = SEED, publicKeys = [jsPublicHex] } = {}) {
  const devices = new Map();
  const license = mintLicenseKey({ edition: "pro", seats, issued: NOW, expires: null, updatesUntil: NOW + 365 * DAY, offline: false, label: "" }, secret);
  let revoked = false;
  let down = false;
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (down) throw new Error("offline");
    const action = new URL(url).searchParams.get("action");
    const body = JSON.parse(init.body);
    calls.push({ action, body, headers: init.headers });
    const reply = (status, data) => ({ ok: status < 400, status, json: async () => data });
    if (revoked) return reply(403, { error: "This license was revoked.", code: "revoked" });
    if (action === "activate" || action === "refresh") {
      if (!devices.has(body.machineId) && devices.size >= seats) {
        return reply(409, { error: "All seats are in use.", code: "seats_full", seats, devices: [...devices.values()].map((d) => ({ name: d.name })) });
      }
      devices.set(body.machineId, { name: body.name });
      return reply(200, {
        ok: true,
        licenseKey: license.key,
        receipt: mintReceipt({ licenseId: license.license.id, machineId: body.machineId, issuedAt: NOW, validUntil: NOW + 30 * DAY }, secret),
        license: { seatsUsed: devices.size },
      });
    }
    if (action === "deactivate") {
      const released = devices.delete(body.machineId);
      return reply(200, { ok: true, released });
    }
    return reply(400, { error: "?" });
  };
  return { fetchImpl, license, devices, calls, revoke: () => (revoked = true), setDown: (v) => (down = v), publicKeys };
}

const baseCtx = (server, machineId) => ({ machineId, name: machineId, platform: "pc", version: "3.39.0", now: NOW + 5, publicKeys: server.publicKeys, fetchImpl: server.fetchImpl, api: "https://license.invalid/api" });

test("client: activate, seats full, deactivate frees a seat, refresh, revoke", async () => {
  const server = fakeServer({ seats: 2 });
  const homes = [tmp(), tmp(), tmp()];
  const a = await activateLicense(homes[0], server.license.key, baseCtx(server, "machine-aaaa-0001"));
  assert.equal(a.ok, true);
  assert.equal(readEntitlements(homes[0], { machineId: "machine-aaaa-0001", publicKeys: server.publicKeys, now: NOW + 5, buildTs: NOW }).can("remote_access"), true);
  assert.match(server.calls[0].headers["user-agent"], /^Drivebay\//, "identifies itself so the host firewall lets it through");
  const b = await activateLicense(homes[1], server.license.key, baseCtx(server, "machine-bbbb-0002"));
  assert.equal(b.ok, true);
  const c = await activateLicense(homes[2], server.license.key, baseCtx(server, "machine-cccc-0003"));
  assert.equal(c.ok, false);
  assert.equal(c.code, "seats_full");
  assert.equal(loadLicenseRecord(homes[2]), null, "a refused activation stores nothing");
  const d = await deactivateLicense(homes[0], baseCtx(server, "machine-aaaa-0001"));
  assert.equal(d.ok && d.released, true);
  assert.equal(loadLicenseRecord(homes[0]), null);
  const c2 = await activateLicense(homes[2], server.license.key, baseCtx(server, "machine-cccc-0003"));
  assert.equal(c2.ok, true, "the freed seat is usable");
  assert.equal((await refreshLicense(homes[1], baseCtx(server, "machine-bbbb-0002"))).ok, true);
  server.revoke();
  const r = await refreshLicense(homes[1], baseCtx(server, "machine-bbbb-0002"));
  assert.equal(r.ok, false);
  const after = readEntitlements(homes[1], { machineId: "machine-bbbb-0002", publicKeys: server.publicKeys, now: NOW + 6, buildTs: NOW });
  assert.equal(after.edition, "free", "revocation turns paid features off at the next check");
  assert.equal(after.state.status, "revoked");
});

test("client: network trouble keeps the current license; deactivate offline needs force", async () => {
  const server = fakeServer({ seats: 1 });
  const home = tmp();
  await activateLicense(home, server.license.key, baseCtx(server, "machine-dddd-0004"));
  server.setDown(true);
  const r = await refreshLicense(home, baseCtx(server, "machine-dddd-0004"));
  assert.equal(r.network, true);
  assert.equal(readEntitlements(home, { machineId: "machine-dddd-0004", publicKeys: server.publicKeys, now: NOW + 6, buildTs: NOW }).edition, "pro", "still Pro while the receipt is valid");
  const soft = await deactivateLicense(home, baseCtx(server, "machine-dddd-0004"));
  assert.equal(soft.ok, false);
  assert.ok(loadLicenseRecord(home));
  const forced = await deactivateLicense(home, { ...baseCtx(server, "machine-dddd-0004"), force: true });
  assert.equal(forced.ok, true);
  assert.equal(loadLicenseRecord(home), null);
  const later = readEntitlements(home, { machineId: "machine-dddd-0004", publicKeys: server.publicKeys, now: NOW + 40 * DAY, buildTs: NOW });
  assert.equal(later.edition, "free");
});

test("client: receipt lapses after 30 days offline until a refresh", async () => {
  const server = fakeServer({ seats: 1 });
  const home = tmp();
  await activateLicense(home, server.license.key, baseCtx(server, "machine-eeee-0005"));
  const ent = (now) => readEntitlements(home, { machineId: "machine-eeee-0005", publicKeys: server.publicKeys, now, buildTs: NOW });
  assert.equal(ent(NOW + 29 * DAY).edition, "pro");
  assert.equal(ent(NOW + 31 * DAY).edition, "free");
  assert.equal(ent(NOW + 31 * DAY).state.needsRefresh, true);
});

test("client: refuses a server answer that does not verify, and junk input", async () => {
  const evil = fakeServer({ seats: 1, secret: Buffer.from("another-test-seed-for-an-imposter".slice(0, 32)).toString("hex"), publicKeys: [jsPublicHex] });
  const home = tmp();
  const out = await activateLicense(home, evil.license.key, baseCtx(evil, "machine-ffff-0006"));
  assert.equal(out.ok, false, "a key signed by someone else is refused before any network call");
  assert.equal(evil.calls.length, 0);
  const junk = await activateLicense(home, "hello", baseCtx(evil, "machine-ffff-0006"));
  assert.equal(junk.code, "format");
  const typo = await activateLicense(home, "DBAY-0123-4567-89AB-CDEG", baseCtx(evil, "machine-ffff-0006"));
  assert.equal(typo.ok, false);
});

test("client: an offline-flagged key activates with no network", async () => {
  const home = tmp();
  const fetchImpl = async () => {
    throw new Error("no network allowed");
  };
  const out = await activateLicense(home, vectors.licenses[2].key, { machineId: "airgapped-host-01", now: NOW + 5, publicKeys: PK, fetchImpl });
  assert.equal(out.ok, true);
  assert.equal(out.offline, true);
  const ent = readEntitlements(home, { machineId: "airgapped-host-01", publicKeys: PK, now: NOW + 50 * DAY, buildTs: NOW + 50 * DAY });
  assert.equal(ent.edition, "enterprise");
  clearLicenseRecord(home);
  saveLicenseRecord(home, { key: "x", receipt: "" });
  assert.equal(loadLicenseRecord(home).key, "x");
});
