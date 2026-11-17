import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { joinProof, newDek, signJoin, verifyJoinProof, verifyJoinSignature } from "../app/src/lib/files/linked-crypto.mjs";
import { approveLocalRequest, handleLinkedHttp, revokeLocalGrant } from "../app/src/lib/files/linked-http.mjs";
import { newMachineKeys, publicPairState, randomToken } from "../app/src/lib/files/linked-machines.mjs";
import { saveIdentity } from "../app/src/lib/files/linked-store.mjs";

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function setup() {
  const home = tmp("db-join-home-");
  const driveA = tmp("db-join-driveA-");
  const driveB = tmp("db-join-driveB-");
  fs.writeFileSync(path.join(driveA, "a.txt"), "alpha");
  fs.writeFileSync(path.join(driveB, "b.txt"), "beta");
  const hostKeys = newMachineKeys();
  saveIdentity(home, { machineId: "host-machine-0001", displayName: "Mac", ...hostKeys });
  const dek = newDek();
  const peerKeys = newMachineKeys();
  const peer = { machineId: "phone-machine-0002", publicKey: peerKeys.publicKey };
  const joinDeps = { dek, lookupPeer: async (_home, id) => (id === peer.machineId ? peer : null) };
  const fullAccess = {
    roots: [{ path: driveA, name: "Macintosh HD" }, { path: driveB, name: "Backup" }],
    policy: { allowUpload: true, allowDelete: true, allowRename: true, allowCreateFolder: true },
  };
  return { home, driveA, driveB, dek, peer, peerKeys, joinDeps, fullAccess };
}

function joinBody(ctx, overrides = {}) {
  const secret = overrides.secret || randomToken();
  const parts = { hostId: "host-machine-0001", peerId: ctx.peer.machineId, secret };
  return {
    machineId: ctx.peer.machineId,
    displayName: "Aaron S25",
    secret,
    proof: joinProof(overrides.dek || ctx.dek, parts),
    signature: signJoin(overrides.privateKey || ctx.peerKeys.privateKey, parts),
    ...overrides.extra,
  };
}

const post = (ctx, pathName, body, remoteAddress = "100.64.0.9") =>
  handleLinkedHttp({
    method: "POST",
    path: pathName,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(body)),
    remoteAddress,
    home: ctx.home,
    fullAccess: ctx.fullAccess,
    joinDeps: ctx.joinDeps,
  });

const json = (res) => JSON.parse(Buffer.from(res.body).toString("utf8"));

const dav = (ctx, token, method, urlPath, { remoteAddress = "100.64.0.9", body, headers = {} } = {}) =>
  handleLinkedHttp({
    method,
    path: urlPath,
    headers: { authorization: `Basic ${Buffer.from(`drivebay:${token}`).toString("base64")}`, depth: "1", ...headers },
    body: body ? Buffer.from(body) : Buffer.alloc(0),
    remoteAddress,
    home: ctx.home,
    fullAccess: ctx.fullAccess,
    joinDeps: ctx.joinDeps,
  });

async function joinAndApprove(ctx, bodyOverrides) {
  const body = joinBody(ctx, bodyOverrides);
  const asked = await post(ctx, "/api/link/request", body);
  if (asked.status !== 200) return { asked };
  const id = json(asked).id;
  const approved = approveLocalRequest(ctx.home, id);
  assert.equal(approved.ok, true);
  const polled = await post(ctx, "/api/link/poll", { id, secret: body.secret });
  return { asked, polled, body };
}

test("join proof is bound to the host, the machine, and the request secret", () => {
  const dek = newDek();
  const keys = newMachineKeys();
  const parts = { hostId: "host-1", peerId: "peer-1", secret: "s".repeat(20) };
  const proof = joinProof(dek, parts);
  assert.equal(verifyJoinProof(dek, parts, proof), true);
  assert.equal(verifyJoinProof(newDek(), parts, proof), false, "another password gives another DEK");
  assert.equal(verifyJoinProof(dek, { ...parts, hostId: "host-2" }, proof), false);
  assert.equal(verifyJoinProof(dek, { ...parts, peerId: "peer-2" }, proof), false);
  assert.equal(verifyJoinProof(dek, { ...parts, secret: "t".repeat(20) }, proof), false);
  const sig = signJoin(keys.privateKey, parts);
  assert.equal(verifyJoinSignature(keys.publicKey, parts, sig), true);
  assert.equal(verifyJoinSignature(newMachineKeys().publicKey, parts, sig), false);
  assert.equal(proof.includes(dek.toString("base64")), false);
});

test("password proof plus approval gives a trusted own machine every drive, read and write", async () => {
  const ctx = setup();
  const { asked, polled, body } = await joinAndApprove(ctx);
  assert.equal(asked.status, 200);
  assert.equal(json(asked).join, true);
  assert.equal(polled.status, 200);
  assert.equal(json(polled).scope, "full");
  const token = json(polled).token;
  const root = await dav(ctx, token, "PROPFIND", "/dav/");
  assert.equal(root.status, 207);
  const xml = Buffer.from(root.body).toString("utf8");
  assert.match(xml, /Macintosh%20HD/);
  assert.match(xml, /Backup/);
  const listing = await dav(ctx, token, "PROPFIND", "/dav/Macintosh%20HD/");
  assert.match(Buffer.from(listing.body).toString("utf8"), /a\.txt/);
  const read = await dav(ctx, token, "GET", "/dav/Backup/b.txt");
  assert.equal(Buffer.from(read.body).toString("utf8"), "beta");
  const put = await dav(ctx, token, "PUT", "/dav/Backup/new.txt", { body: "hello" });
  assert.equal(put.status, 201);
  assert.equal(fs.readFileSync(path.join(ctx.driveB, "new.txt"), "utf8"), "hello");
  const state = publicPairState(JSON.parse(fs.readFileSync(path.join(ctx.home, "pair-state.json"), "utf8")));
  assert.equal(state.grants[0].scope, "full");
  assert.equal(JSON.stringify(state).includes(body.proof), false);
});

test("the pending request shows as a join request until a trusted machine approves it", async () => {
  const ctx = setup();
  const body = joinBody(ctx);
  const asked = await post(ctx, "/api/link/request", body);
  const id = json(asked).id;
  const early = await post(ctx, "/api/link/poll", { id, secret: body.secret });
  assert.equal(early.status, 409, "password alone is not enough");
  const state = publicPairState(JSON.parse(fs.readFileSync(path.join(ctx.home, "pair-state.json"), "utf8")));
  assert.equal(state.pending.length, 1);
  assert.equal(state.pending[0].join, true);
  assert.equal(state.pending[0].name, "Aaron S25");
});

test("a wrong join password, a stranger's device key, or a machine off this login is refused", async () => {
  const ctx = setup();
  const wrongPassword = await post(ctx, "/api/link/request", joinBody(ctx, { dek: newDek() }));
  assert.equal(wrongPassword.status, 403);
  assert.equal(json(wrongPassword).reason, "bad-password");
  const wrongKey = await post(ctx, "/api/link/request", joinBody(ctx, { privateKey: newMachineKeys().privateKey }));
  assert.equal(wrongKey.status, 403);
  assert.equal(json(wrongKey).reason, "bad-device-key");
  const stranger = joinBody(ctx);
  const offLogin = await post(ctx, "/api/link/request", { ...stranger, machineId: "stranger-machine-9" });
  assert.equal(offLogin.status, 403);
  const file = path.join(ctx.home, "pair-state.json");
  const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  assert.equal((state.pending || []).length, 0);
});

test("a host that has no join password cannot verify a join and refuses it", async () => {
  const ctx = setup();
  ctx.joinDeps = { ...ctx.joinDeps, dek: null };
  const res = await post(ctx, "/api/link/request", joinBody(ctx));
  assert.equal(res.status, 403);
  assert.equal(json(res).reason, "host-locked");
});

test("a request without the proof still works but only gets the shared-folder list", async () => {
  const ctx = setup();
  const secret = randomToken();
  const asked = await post(ctx, "/api/link/request", { machineId: "guest-machine-77", displayName: "Guest", secret });
  assert.equal(json(asked).join, false);
  approveLocalRequest(ctx.home, json(asked).id);
  const polled = await post(ctx, "/api/link/poll", { id: json(asked).id, secret });
  assert.equal(json(polled).scope, "shares");
  const root = await dav(ctx, json(polled).token, "PROPFIND", "/dav/");
  assert.doesNotMatch(Buffer.from(root.body).toString("utf8"), /Macintosh/);
  const blocked = await dav(ctx, json(polled).token, "GET", "/dav/Macintosh%20HD/a.txt");
  assert.equal(blocked.status, 404);
});

test("a full grant is ignored off the tailnet and LAN, and server-lock write switches still apply", async () => {
  const ctx = setup();
  const { polled } = await joinAndApprove(ctx);
  const token = json(polled).token;
  const pub = await dav(ctx, token, "PROPFIND", "/dav/", { remoteAddress: "203.0.113.5" });
  assert.equal(pub.status, 403, "default reach mode refuses public peers");
  ctx.fullAccess = { ...ctx.fullAccess, policy: { ...ctx.fullAccess.policy, allowDelete: false, allowUpload: false } };
  const del = await dav(ctx, token, "DELETE", "/dav/Backup/b.txt");
  assert.equal(del.status, 403);
  const put = await dav(ctx, token, "PUT", "/dav/Backup/x.txt", { body: "x" });
  assert.equal(put.status, 403);
  assert.equal(fs.existsSync(path.join(ctx.driveB, "b.txt")), true);
});

test("a drive can never be escaped with .. or a symlink, and the drive itself cannot be deleted", async () => {
  const ctx = setup();
  const { polled } = await joinAndApprove(ctx);
  const token = json(polled).token;
  const outside = tmp("db-join-outside-");
  fs.writeFileSync(path.join(outside, "secret.txt"), "no");
  fs.symlinkSync(outside, path.join(ctx.driveA, "link"));
  const traverse = await dav(ctx, token, "GET", "/dav/Backup/%2e%2e/secret.txt");
  assert.equal(traverse.status, 400);
  const viaLink = await dav(ctx, token, "GET", "/dav/Macintosh%20HD/link/secret.txt");
  assert.equal(viaLink.status, 403);
  const delRoot = await dav(ctx, token, "DELETE", "/dav/Backup");
  assert.equal(delRoot.status, 403);
});

test("Forget revokes the grant: the next request is refused", async () => {
  const ctx = setup();
  const { polled } = await joinAndApprove(ctx);
  const token = json(polled).token;
  assert.equal((await dav(ctx, token, "PROPFIND", "/dav/")).status, 207);
  assert.equal(revokeLocalGrant(ctx.home, ctx.peer.machineId).ok, true);
  assert.equal((await dav(ctx, token, "PROPFIND", "/dav/")).status, 401);
  assert.equal(revokeLocalGrant(ctx.home, ctx.peer.machineId).ok, false);
});

test("the 6-digit code still works and stays shared-folders only", async () => {
  const ctx = setup();
  const { issueLocalCode } = await import("../app/src/lib/files/linked-http.mjs");
  issueLocalCode(ctx.home, "123456");
  const res = await post(ctx, "/api/link/redeem", { code: "123456", machineId: ctx.peer.machineId, displayName: "Phone" });
  assert.equal(res.status, 200);
  const root = await dav(ctx, json(res).token, "PROPFIND", "/dav/");
  assert.doesNotMatch(Buffer.from(root.body).toString("utf8"), /Macintosh/);
});

test("the DAV middleware sends 204 without a body so a successful DELETE is not a 500", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync(new URL("../app/server/middleware/linked-dav.ts", import.meta.url), "utf8");
  assert.match(source, /result\.status === 204/);
  assert.match(source, /new Response\(noBody \? null : bytes/);
  // The same rule holds for the real Response class.
  assert.throws(() => new Response(new Uint8Array(), { status: 204 }), /Invalid response status code 204/);
  assert.equal(new Response(null, { status: 204 }).status, 204);
});
