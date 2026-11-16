import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  ARGON2_PARAMS,
  CANNOT_RECOVER_MESSAGE,
  DIRECTORY_FIELDS,
  ENVELOPE_KEYS,
  buildEnvelope,
  decryptDirectory,
  derivePassphraseKey,
  encryptDirectory,
  isLegacyPlaintext,
  migratePlaintextRows,
  newDek,
  newRecoveryKey,
  openEnvelope,
  sanitizeEnvelope,
  unwrapWithPassphrase,
  unwrapWithPrf,
  unwrapWithRecoveryKey,
  wrapWithPassphrase,
  wrapWithPrf,
  wrapWithRecoveryKey,
} from "../app/src/lib/files/linked-crypto.mjs";
import { newMachineId, newMachineKeys, sanitizeRegistration } from "../app/src/lib/files/linked-machines.mjs";
import { ensureIdentity } from "../app/src/lib/files/linked-cloud.mjs";
import { setupVault, loadDek, envelopeFor, openListedMachines, vaultStatus } from "../app/src/lib/files/linked-vault.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const sample = {
  machineId: "machine-office-1",
  displayName: "Office PC",
  type: "pc",
  tailscaleHost: "100.64.0.8",
  lanAddress: "192.168.1.20",
  port: 8765,
  publicKey: "B".repeat(40),
  lastSeen: "2026-11-16T10:00:00.000Z",
  hidden: true,
  directInternet: true,
  publicHost: "203.0.113.5",
};

test("AES-256-GCM round-trips the directory fields and the server cannot read them from the envelope", () => {
  const dek = newDek();
  const built = buildEnvelope(dek, sample);
  assert.equal(built.ok, true);
  for (const key of DIRECTORY_FIELDS) {
    assert.equal(JSON.stringify(built.envelope).includes(String(sample[key])), false, key);
  }
  const opened = openEnvelope(dek, built.envelope);
  assert.equal(opened.ok, true);
  assert.equal(opened.machine.displayName, "Office PC");
  assert.equal(opened.machine.hidden, true);
  assert.equal(opened.machine.publicHost, "203.0.113.5");
  assert.equal(opened.machine.port, 8765);
  const other = openEnvelope(newDek(), built.envelope);
  assert.equal(other.ok, false);
});

test("encrypted envelopes refuse plaintext secrets and connection fields", () => {
  const dek = newDek();
  const built = buildEnvelope(dek, sample);
  const clean = sanitizeEnvelope(built.envelope);
  assert.equal(clean.ok, true);
  assert.deepEqual(Object.keys(clean.envelope).sort(), [...ENVELOPE_KEYS].sort());
  for (const extra of ["password", "token", "privateKey", "publicKey", "displayName", "lanAddress", "folders"]) {
    assert.equal(sanitizeEnvelope({ ...built.envelope, [extra]: "nope" }).ok, false, extra);
  }
});

test("a passphrase wrap uses Argon2id and a recovery key unlocks the same DEK", () => {
  const dek = newDek();
  const wrap = wrapWithPassphrase(dek, "correct horse battery");
  assert.equal(wrap.kind, "passphrase");
  assert.equal(wrap.params.t, ARGON2_PARAMS.t);
  assert.equal(wrap.params.m, ARGON2_PARAMS.m);
  const opened = unwrapWithPassphrase(wrap, "correct horse battery");
  assert.deepEqual(opened, dek);
  assert.throws(() => unwrapWithPassphrase(wrap, "wrong passphrase"));
  const recovery = newRecoveryKey();
  assert.match(recovery, /^[A-Z0-9]{5}(-[A-Z0-9]{5}){3}$/);
  assert.equal(recovery.includes("undefined"), false);
  for (let i = 0; i < 200; i++) {
    const key = newRecoveryKey();
    assert.match(key, /^[A-Z0-9]{5}(-[A-Z0-9]{5}){3}$/);
    assert.equal(key.includes("undefined"), false);
  }
  const rec = wrapWithRecoveryKey(dek, recovery);
  assert.deepEqual(unwrapWithRecoveryKey(rec, recovery.toLowerCase()), dek);
});

test("a passkey PRF wrap unlocks the DEK and the PRF bytes are not in the wrap record", () => {
  const dek = newDek();
  const prf = Buffer.alloc(32, 7);
  const wrap = wrapWithPrf(dek, prf, "cred-1");
  assert.equal(wrap.kind, "passkey");
  assert.equal(JSON.stringify(wrap).includes(prf.toString("base64")), false);
  assert.deepEqual(unwrapWithPrf(wrap, prf), dek);
});

test("legacy plaintext rows migrate into envelopes the same DEK can open", () => {
  const dek = newDek();
  const migrated = migratePlaintextRows(dek, [sample], sample.lastSeen);
  assert.equal(migrated.ok, true);
  assert.equal(isLegacyPlaintext(sample), true);
  assert.equal(isLegacyPlaintext(migrated.envelopes[0]), false);
  const opened = openEnvelope(dek, migrated.envelopes[0]);
  assert.equal(opened.machine.lanAddress, sample.lanAddress);
});

test("setupVault stores a device wrap, never writes the DEK, and requires a passphrase", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-vault-"));
  try {
    ensureIdentity(home, "Test PC");
    const missing = setupVault(home, { passphrase: "short" });
    assert.equal(missing.ok, false);
    const setup = setupVault(home, { passphrase: "a long enough phrase" });
    assert.equal(setup.ok, true);
    assert.equal(setup.message, CANNOT_RECOVER_MESSAGE);
    assert.ok(setup.recoveryKey);
    assert.equal(setup.wraps.some((row) => row.kind === "passphrase"), true);
    assert.equal(setup.wraps.some((row) => row.kind === "recovery"), true);
    const raw = fs.readFileSync(path.join(home, "mesa-vault.json"), "utf8");
    assert.equal(raw.includes(setup.dek.toString("base64")), false);
    assert.equal(raw.includes(setup.recoveryKey), false);
    const dek = loadDek(home);
    assert.ok(dek);
    const env = envelopeFor(home, sample, dek);
    assert.equal(env.ok, true);
    const listed = openListedMachines(dek, { machines: [env.envelope] });
    assert.equal(listed.machines[0].displayName, "Office PC");
    assert.equal(vaultStatus(home).ready, true);
    assert.equal(vaultStatus(home).unlocked, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the private machine key never appears in a cloud registration or envelope", () => {
  const keys = newMachineKeys();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-id-"));
  try {
    const identity = ensureIdentity(home, "Hidden");
    assert.ok(identity.privateKey);
    const dek = newDek();
    const env = buildEnvelope(dek, { ...sample, publicKey: identity.publicKey });
    assert.equal(JSON.stringify(env.envelope).includes(identity.privateKey), false);
    const plain = sanitizeRegistration({ ...sample, publicKey: identity.publicKey });
    assert.equal(JSON.stringify(plain).includes(identity.privateKey), false);
    assert.ok(keys.privateKey.length > 16);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("PHP cloud helpers accept v2 envelopes and refuse a raw DEK", () => {
  const script = `
    require '${root}/server/cloud-api/lib/machines.php';
    require '${root}/server/cloud-api/lib/vault.php';
    $plain = array(
      'machineId' => 'machine-office-1',
      'displayName' => 'Office',
      'type' => 'pc',
      'tailscaleHost' => '100.64.0.8',
      'lanAddress' => '192.168.1.20',
      'port' => 8765,
      'publicKey' => str_repeat('B', 40),
      'lastSeen' => '2026-11-16T10:00:00Z',
      'hidden' => false,
      'directInternet' => false,
      'publicHost' => '',
    );
    $ok = drivebay_accept_machine($plain, false);
    if (!$ok) { fwrite(STDERR, "plain refused\\n"); exit(2); }
    $locked = drivebay_accept_machine($plain, true);
    if ($locked !== null) { fwrite(STDERR, "plain allowed after lock\\n"); exit(3); }
    $env = array(
      'machineId' => 'machine-office-1',
      'lastSeen' => '2026-11-16T10:00:00Z',
      'ciphertext' => str_repeat('A', 40),
      'nonce' => str_repeat('N', 16),
      'envelopeVersion' => 2,
    );
    $got = drivebay_sanitize_envelope($env);
    if (!$got) { fwrite(STDERR, "envelope refused\\n"); exit(4); }
    $bad = drivebay_sanitize_envelope(array_merge($env, array('dek' => 'secret')));
    if ($bad !== null) { fwrite(STDERR, "dek accepted\\n"); exit(5); }
    $wrap = drivebay_sanitize_wrap(array(
      'wrapId' => 'wrap-pass-1234',
      'kind' => 'passphrase',
      'alg' => 'argon2id-aes-256-gcm',
      'salt' => str_repeat('S', 16),
      'nonce' => str_repeat('N', 16),
      'wrappedDek' => str_repeat('W', 32),
      'params' => array('t' => 2, 'm' => 19456, 'p' => 1),
      'credentialId' => '',
    ));
    if (!$wrap) { fwrite(STDERR, "wrap refused\\n"); exit(6); }
    echo "ok";
  `;
  const result = spawnSync("php", ["-r", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), "ok");
});

test("PHP bootstrap redacts bearer tokens and the migrate script is not a web endpoint", () => {
  const bootstrap = fs.readFileSync(path.join(root, "server/cloud-api/lib/bootstrap.php"), "utf8");
  assert.match(bootstrap, /drivebay_redact_log/);
  assert.match(bootstrap, /\[redacted\]/);
  const ht = fs.readFileSync(path.join(root, "server/cloud-api/.htaccess"), "utf8");
  assert.match(ht, /migrate-/);
  assert.match(ht, /Authorization/);
  const migrate = fs.readFileSync(path.join(root, "server/cloud-api/migrate-33800.php"), "utf8");
  assert.match(migrate, /PHP_SAPI/);
  const script = `require '${root}/server/cloud-api/lib/bootstrap.php'; echo drivebay_redact_log('Authorization: Bearer super.secret.token');`;
  const result = spawnSync("php", ["-r", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes("super.secret.token"), false);
  assert.match(result.stdout, /\[redacted\]/);
});
