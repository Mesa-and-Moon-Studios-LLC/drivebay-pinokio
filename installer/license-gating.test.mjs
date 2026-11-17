import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { handleLinkedHttp } from "../app/src/lib/files/linked-http.mjs";
import { ensureIdentity } from "../app/src/lib/files/linked-cloud.mjs";
import { writePrivate } from "../app/src/lib/files/linked-store.mjs";
import { hashSecret, randomSalt, randomToken } from "../app/src/lib/files/linked-machines.mjs";
import { evaluateLicense, makeEntitlements } from "../app/src/lib/license/license-store.mjs";
import { requestReach, writeRemoteAccessFile, nextRemoteAccess } from "../app/src/lib/files/public-access.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vectors = JSON.parse(fs.readFileSync(path.join(root, "docs", "license-test-vectors.json"), "utf8"));
const NOWS = vectors.issued + 5;
const MID = vectors.receipt.machineId;

function entitlementsFor(edition) {
  if (edition === "free") return makeEntitlements(evaluateLicense(null, { machineId: MID, now: NOWS, publicKeys: [vectors.publicKeyHex] }));
  const pick = { pro: 0, elite: 1, enterprise: 2 }[edition];
  const v = vectors.licenses[pick];
  // Receipts in the vectors belong to the pro license and MID; elite is simulated with its own offline-free path below.
  const record = pick === 2 ? { key: v.key } : null;
  if (record) return makeEntitlements(evaluateLicense(record, { machineId: MID, now: NOWS, publicKeys: [vectors.publicKeyHex] }));
  if (edition === "pro") {
    return makeEntitlements(evaluateLicense({ key: v.key, receipt: vectors.receipt.text, lastCheckAt: vectors.issued }, { machineId: MID, now: NOWS, buildTs: vectors.issued, publicKeys: [vectors.publicKeyHex] }));
  }
  // Elite: the policy only reads the edition, so use a synthetic active state.
  return makeEntitlements({ edition: "elite", name: "Elite", status: "active" });
}

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-gate-"));
  ensureIdentity(home, "Mac Mini");
  const token = randomToken();
  const salt = randomSalt();
  writePrivate(path.join(home, "pair-state.json"), {
    code: null,
    pending: [],
    grants: { phone1: { salt, tokenHash: hashSecret(token, salt), name: "Phone" } },
  });
  return { home, token, file: path.join(home, "public-access.json") };
}

function turnOn(ctx, entitlements, minutes = 15) {
  return handleLinkedHttp({
    method: "POST",
    path: "/api/link/remote-access",
    headers: { authorization: `Bearer ${ctx.token}` },
    body: Buffer.from(JSON.stringify({ enabled: true, minutes, mode: "ro", displayName: "Phone" })),
    remoteAddress: "100.64.0.22",
    home: ctx.home,
    now: 1_700_000_000_000,
    accessFile: ctx.file,
    reachMode: "both",
    entitlements,
  });
}

test("Free: turning remote access on over Tailscale is refused with a friendly upgrade message", async () => {
  const ctx = setup();
  try {
    const res = await turnOn(ctx, entitlementsFor("free"));
    assert.equal(res.status, 402);
    const body = JSON.parse(res.body.toString());
    assert.equal(body.upgrade, true);
    assert.equal(body.feature, "remote_access");
    assert.equal(body.requiredEdition, "pro");
    assert.match(body.error, /Your own machines still link and open each other for free/);
    assert.equal(fs.existsSync(ctx.file), false, "nothing was switched on");
  } finally {
    fs.rmSync(ctx.home, { recursive: true, force: true });
  }
});

test("Free: reading status and switching OFF still work", async () => {
  const ctx = setup();
  try {
    const get = await handleLinkedHttp({
      method: "GET", path: "/api/link/remote-access", headers: { authorization: `Bearer ${ctx.token}` },
      remoteAddress: "100.64.0.22", home: ctx.home, now: 1_700_000_000_000, accessFile: ctx.file, reachMode: "both", entitlements: entitlementsFor("free"),
    });
    assert.equal(get.status, 200);
    const off = await handleLinkedHttp({
      method: "POST", path: "/api/link/remote-access", headers: { authorization: `Bearer ${ctx.token}` },
      body: Buffer.from(JSON.stringify({ enabled: false })), remoteAddress: "100.64.0.22", home: ctx.home, now: 1_700_000_000_000, accessFile: ctx.file, reachMode: "both", entitlements: entitlementsFor("free"),
    });
    assert.equal(off.status, 200);
  } finally {
    fs.rmSync(ctx.home, { recursive: true, force: true });
  }
});

test("Pro: 15 minutes to 4 hours work, 24 hours asks for Elite", async () => {
  const ctx = setup();
  try {
    const pro = entitlementsFor("pro");
    assert.equal(pro.edition, "pro");
    assert.equal((await turnOn(ctx, pro, 240)).status, 200);
    const long = await turnOn(ctx, pro, 1440);
    assert.equal(long.status, 402);
    assert.equal(JSON.parse(long.body.toString()).requiredEdition, "elite");
    assert.equal((await turnOn(ctx, entitlementsFor("elite"), 1440)).status, 200);
  } finally {
    fs.rmSync(ctx.home, { recursive: true, force: true });
  }
});

test("Enterprise offline license enables remote access", async () => {
  const ctx = setup();
  try {
    const ent = entitlementsFor("enterprise");
    assert.equal(ent.edition, "enterprise");
    assert.equal((await turnOn(ctx, ent, 1440)).status, 200);
  } finally {
    fs.rmSync(ctx.home, { recursive: true, force: true });
  }
});

test("a lapsed license closes public reach at once even though the timer is still running", async () => {
  const ctx = setup();
  try {
    const now = 1_700_000_000_000;
    writeRemoteAccessFile(ctx.file, nextRemoteAccess({ enabled: true, minutes: 240, mode: "rw", now, source: "remote", byName: "Phone" }));
    const dav = (entitlements) =>
      handleLinkedHttp({
        method: "PROPFIND", path: "/dav/", headers: { depth: "0" }, remoteAddress: "8.8.8.8", home: ctx.home, now: now + 1000,
        accessFile: ctx.file, reachMode: "both", entitlements,
      });
    const paid = await dav(entitlementsFor("pro"));
    assert.doesNotMatch(paid.body.toString(), /Public access is off/, "a paid edition is not refused at the reach gate");
    const free = await dav(entitlementsFor("free"));
    assert.equal(free.status, 403);
    assert.match(free.body.toString(), /Public access is off/);
    assert.equal(requestReach("both", "100.64.0.9", { enabled: false }, now), "allow", "Tailscale is never gated");
  } finally {
    fs.rmSync(ctx.home, { recursive: true, force: true });
  }
});

test("own-machine linking is not behind a license: pairing routes never mention the gate", () => {
  const http = fs.readFileSync(path.join(root, "app/src/lib/files/linked-http.mjs"), "utf8");
  for (const route of ["/api/link/join", "/api/link/poll", "/api/link/reciprocal", "/api/link/redeem"]) {
    const start = http.indexOf(route);
    if (start < 0) continue;
    const next = http.indexOf("if (pathname ===", start + 10);
    const block = http.slice(start, next < 0 ? undefined : next);
    assert.doesNotMatch(block, /ent\.can|upgradeMessage|402/, `${route} must stay free`);
  }
});

test("the other gates are wired: public access, local remote access, shared folder cap, runtime reach", () => {
  const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
  assert.match(read("app/src/lib/files/api.functions.ts"), /can\("public_access"\)/);
  const fn = read("app/src/lib/files/linked-machines.functions.ts");
  assert.match(fn, /can\("remote_access"\)/);
  assert.match(fn, /remoteMinutesAllowed/);
  assert.match(fn, /sharedFolderLimit/);
  assert.match(fn, /Math\.max\(limit, already\)/, "existing shared folders are grandfathered");
  assert.match(read("app/src/start.ts"), /can\("remote_access"\)/);
  assert.match(read("app/server/middleware/linked-dav.ts"), /entitlements: \(\) =>/);
});
