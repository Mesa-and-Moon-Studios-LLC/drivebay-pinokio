import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  formatCountdown,
  nextRemoteAccess,
  publicWriteAllowed,
  readRemoteAccessFile,
  remoteAccessBanner,
  REMOTE_ACCESS_BANNER,
  requestReach,
  writeRemoteAccessFile,
} from "../app/src/lib/files/public-access.mjs";
import { handleDav } from "../app/src/lib/files/linked-dav.mjs";
import { handleLinkedHttp, issueLocalCode } from "../app/src/lib/files/linked-http.mjs";
import { ensureIdentity } from "../app/src/lib/files/linked-cloud.mjs";
import { saveShares, writePrivate } from "../app/src/lib/files/linked-store.mjs";
import { hashSecret, redeemCode, freshPairState, randomSalt, randomToken } from "../app/src/lib/files/linked-machines.mjs";

test("remote access requires a time limit and supports read-only", () => {
  const now = 1_700_000_000_000;
  const on = nextRemoteAccess({ enabled: true, minutes: 15, mode: "ro", now, source: "remote", byName: "Bob's phone" });
  assert.equal(on.enabled, true);
  assert.equal(on.mode, "ro");
  assert.equal(on.offAt, now + 15 * 60 * 1000);
  assert.throws(() => nextRemoteAccess({ enabled: true, minutes: 2, mode: "rw", now }), /15 minutes/);
  const banner = remoteAccessBanner(on, now);
  assert.equal(banner.message, REMOTE_ACCESS_BANNER);
  assert.equal(banner.mode, "ro");
  assert.equal(formatCountdown(banner.remainingMs), "15:00");
  assert.equal(publicWriteAllowed("both", "8.8.8.8", on, now), false);
  assert.equal(publicWriteAllowed("both", "100.64.0.8", on, now), true);
  assert.equal(requestReach("both", "8.8.8.8", on, now), "allow");
  const off = nextRemoteAccess({ enabled: false, minutes: 15, mode: "rw", now });
  assert.equal(requestReach("both", "8.8.8.8", off, now), "deny");
  assert.equal(requestReach("both", "100.64.0.8", off, now), "allow");
});

test("the remote-access file keeps extras while public-access tests still see enabled/offAt", () => {
  const now = 1_700_000_000_000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-remote-"));
  const file = path.join(dir, "public-access.json");
  try {
    writeRemoteAccessFile(file, nextRemoteAccess({ enabled: true, minutes: 60, mode: "rw", now, source: "remote", byName: "Phone" }));
    const read = readRemoteAccessFile(file, now + 1000);
    assert.equal(read.enabled, true);
    assert.equal(read.mode, "rw");
    assert.equal(read.byName, "Phone");
    const expired = readRemoteAccessFile(file, now + 60 * 60 * 1000);
    assert.deepEqual({ enabled: expired.enabled, offAt: expired.offAt }, { enabled: false, offAt: null });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("WebDAV writes over the public path are refused when remote access is read-only", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-dav-ro-"));
  try {
    const share = path.join(dir, "share");
    fs.mkdirSync(share);
    fs.writeFileSync(path.join(share, "note.txt"), "hi");
    const token = "pair-token-for-tests-0123456789";
    const salt = randomSalt();
    const pairState = { code: null, pending: [], grants: { m1: { salt, tokenHash: hashSecret(token, salt) } } };
    const shares = { folders: [{ path: share, access: "rw", name: "Docs" }], directInternet: true, hidden: false, publicHost: "203.0.113.5" };
    const denied = await handleDav({
      method: "PUT",
      urlPath: "/dav/Docs/note.txt",
      headers: { authorization: "Basic " + Buffer.from("drivebay:" + token).toString("base64") },
      body: Buffer.from("x"),
      shares,
      pairState,
      remoteIsPrivate: false,
      directInternet: true,
      publicWrite: false,
    });
    assert.equal(denied.status, 403);
    assert.match(denied.body.toString(), /read-only/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a Tailscale-paired device can turn remote access on and off; a public address cannot", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-link-remote-"));
  try {
    ensureIdentity(home, "Mac Mini");
    const token = randomToken();
    const salt = randomSalt();
    writePrivate(path.join(home, "pair-state.json"), {
      code: null,
      pending: [],
      grants: { phone1: { salt, tokenHash: hashSecret(token, salt), name: "Phone" } },
    });
    const file = path.join(home, "public-access.json");
    const refused = await handleLinkedHttp({
      method: "POST",
      path: "/api/link/remote-access",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ enabled: true, minutes: 15, mode: "ro", displayName: "Phone" })),
      remoteAddress: "8.8.8.8",
      home,
      now: 1_700_000_000_000,
      accessFile: file,
      reachMode: "both",
    });
    assert.equal(refused.status, 403);

    const tailscaleOnly = await handleLinkedHttp({
      method: "POST",
      path: "/api/link/remote-access",
      headers: { authorization: `Bearer ${token}` },
      body: Buffer.from(JSON.stringify({ enabled: true, minutes: 15, mode: "ro", displayName: "Phone" })),
      remoteAddress: "100.64.0.22",
      home,
      now: 1_700_000_000_000,
      accessFile: file,
      reachMode: "tailscale",
    });
    assert.equal(tailscaleOnly.status, 409);

    const on = await handleLinkedHttp({
      method: "POST",
      path: "/api/link/remote-access",
      headers: { authorization: `Bearer ${token}` },
      body: Buffer.from(JSON.stringify({ enabled: true, minutes: 15, mode: "ro", displayName: "Phone" })),
      remoteAddress: "100.64.0.22",
      home,
      now: 1_700_000_000_000,
      accessFile: file,
      reachMode: "both",
    });
    assert.equal(on.status, 200, on.body.toString());
    const body = JSON.parse(on.body.toString());
    assert.equal(body.enabled, true);
    assert.equal(body.mode, "ro");
    assert.equal(body.countdown, "15:00");
    assert.match(body.banner, /Remote access is on/);
    const status = await handleLinkedHttp({
      method: "GET",
      path: "/api/link/remote-access",
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: "100.64.0.22",
      home,
      now: 1_700_000_000_000,
      accessFile: file,
    });
    assert.equal(JSON.parse(status.body.toString()).enabled, true);
    const off = await handleLinkedHttp({
      method: "POST",
      path: "/api/link/remote-access",
      headers: { authorization: `Bearer ${token}` },
      body: Buffer.from(JSON.stringify({ enabled: false })),
      remoteAddress: "100.64.0.22",
      home,
      now: 1_700_000_000_000,
      accessFile: file,
      reachMode: "both",
    });
    assert.equal(JSON.parse(off.body.toString()).enabled, false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
