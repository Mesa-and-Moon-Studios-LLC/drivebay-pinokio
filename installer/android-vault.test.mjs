import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Android generates a real Ed25519 keypair and keeps the private key on the phone", () => {
  const panel = fs.readFileSync(path.join(root, "android/app/src/main/java/com/lordstryfe/drivebay/MesaPanel.kt"), "utf8");
  const keys = fs.readFileSync(path.join(root, "android/app/src/main/java/com/lordstryfe/drivebay/MachineKeys.kt"), "utf8");
  const vault = fs.readFileSync(path.join(root, "android/app/src/main/java/com/lordstryfe/drivebay/MesaVault.kt"), "utf8");
  assert.match(keys, /Ed25519KeyPairGenerator/);
  assert.match(keys, /spkiPrefix|302a300506032b6570032100/);
  assert.match(panel, /MachineKeys\.generate/);
  assert.match(panel, /mesa-machine-private/);
  assert.equal(panel.includes("ByteArray(32).also { SecureRandom().nextBytes(it) }"), false);
  assert.match(vault, /Argon2Parameters.ARGON2_id/);
  assert.match(vault, /AES\/GCM\/NoPadding/);
  assert.match(vault, /envelopeVersion/);
  assert.match(vault, /CANNOT_RECOVER/);
});

test("the passkey bridge never puts a PRF secret in a URL", () => {
  const page = fs.readFileSync(path.join(root, "firebase-hosting/public/drivebay-passkey.html"), "utf8");
  assert.match(page, /prf/);
  assert.match(page, /postMessage/);
  assert.doesNotMatch(page, /prfOutput.*searchParams|hash.*prf|location\.href.*prfOutput/);
  assert.match(page, /drivebay-prf/);
});

test("Android can turn remote access on from a Tailscale-paired phone", () => {
  const panel = fs.readFileSync(path.join(root, "android/app/src/main/java/com/lordstryfe/drivebay/MesaPanel.kt"), "utf8");
  assert.match(panel, /remoteAccessDialog/);
  assert.match(panel, /api\/link\/remote-access/);
  assert.match(panel, /Turn remote access on from a device that is already on the Tailscale network/);
});
