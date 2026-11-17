import assert from "node:assert/strict";
import fs from "node:fs";
import os from "os";
import path from "node:path";
import test from "node:test";
import { joinProof, newDek, signJoin } from "../app/src/lib/files/linked-crypto.mjs";
import { approveLocalRequest, handleLinkedHttp, revokeLocalGrant } from "../app/src/lib/files/linked-http.mjs";
import { newMachineKeys, randomToken } from "../app/src/lib/files/linked-machines.mjs";
import { loadLinkedTokens, loadPairState, saveIdentity } from "../app/src/lib/files/linked-store.mjs";
import { signForget, signReciprocal } from "../app/src/lib/files/linked-reciprocal.mjs";
import { browseUrl, listRemote, normalizePath } from "../app/src/lib/files/linked-browse.mjs";

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function setup() {
  const home = tmp("db-recip-home-");
  const hostKeys = newMachineKeys();
  saveIdentity(home, { machineId: "host-machine-0001", displayName: "Mac", ...hostKeys });
  const dek = newDek();
  const peerKeys = newMachineKeys();
  const peer = { machineId: "phone-machine-0002", publicKey: peerKeys.publicKey };
  const joinDeps = { dek, lookupPeer: async (_home, id) => (id === peer.machineId ? peer : null) };
  return { home, dek, peer, peerKeys, joinDeps };
}

const post = (ctx, pathName, body, headers = {}, remoteAddress = "100.64.0.9") =>
  handleLinkedHttp({
    method: "POST",
    path: pathName,
    headers: { "content-type": "application/json", ...headers },
    body: Buffer.from(JSON.stringify(body)),
    remoteAddress,
    home: ctx.home,
    joinDeps: ctx.joinDeps,
  });

const jsonOf = (res) => JSON.parse(Buffer.from(res.body).toString("utf8"));

async function approvedToken(ctx) {
  const secret = randomToken();
  const parts = { hostId: "host-machine-0001", peerId: ctx.peer.machineId, secret };
  const asked = await post(ctx, "/api/link/request", {
    machineId: ctx.peer.machineId,
    displayName: "Aaron S25",
    secret,
    proof: joinProof(ctx.dek, parts),
    signature: signJoin(ctx.peerKeys.privateKey, parts),
  });
  assert.equal(asked.status, 200);
  const id = jsonOf(asked).id;
  assert.equal(approveLocalRequest(ctx.home, id).ok, true);
  const polled = await post(ctx, "/api/link/poll", { id, secret });
  assert.equal(polled.status, 200);
  const payload = jsonOf(polled);
  assert.equal(payload.scope, "full");
  return payload.token;
}

test("an approved join can offer a signed reciprocal grant the host saves", async () => {
  const ctx = setup();
  const inbound = await approvedToken(ctx);
  const accessToken = "db_" + "ab".repeat(32);
  const issuedAt = "2026-11-17T19:02:00.000Z";
  const offer = { hostId: "host-machine-0001", peerId: ctx.peer.machineId, accessToken, issuedAt };
  const signature = signReciprocal(ctx.peerKeys.privateKey, offer);
  const res = await post(ctx, "/api/link/reciprocal", { offer, signature }, { authorization: `Bearer ${inbound}` });
  assert.equal(res.status, 200, Buffer.from(res.body).toString());
  const saved = loadLinkedTokens(ctx.home)[ctx.peer.machineId];
  assert.equal(saved.token, accessToken);
  assert.equal(saved.scope, "full");
  assert.equal(saved.reciprocal, true);
});

test("a reciprocal offer with the wrong device key is refused and no token is saved", async () => {
  const ctx = setup();
  const inbound = await approvedToken(ctx);
  const other = newMachineKeys();
  const accessToken = "db_" + "cd".repeat(32);
  const issuedAt = "2026-11-17T19:02:00.000Z";
  const offer = { hostId: "host-machine-0001", peerId: ctx.peer.machineId, accessToken, issuedAt };
  const res = await post(
    ctx,
    "/api/link/reciprocal",
    { offer, signature: signReciprocal(other.privateKey, offer) },
    { authorization: `Bearer ${inbound}` },
  );
  assert.equal(res.status, 403);
  assert.equal(loadLinkedTokens(ctx.home)[ctx.peer.machineId], undefined);
});

test("forget with the inbound token drops the grant and the reciprocal token", async () => {
  const ctx = setup();
  const inbound = await approvedToken(ctx);
  const accessToken = "db_" + "ef".repeat(32);
  const issuedAt = "2026-11-17T19:02:00.000Z";
  const offer = { hostId: "host-machine-0001", peerId: ctx.peer.machineId, accessToken, issuedAt };
  const offered = await post(
    ctx,
    "/api/link/reciprocal",
    { offer, signature: signReciprocal(ctx.peerKeys.privateKey, offer) },
    { authorization: `Bearer ${inbound}` },
  );
  assert.equal(offered.status, 200);
  const forgotten = await post(ctx, "/api/link/forget", {}, { authorization: `Bearer ${inbound}` });
  assert.equal(forgotten.status, 200, Buffer.from(forgotten.body).toString());
  assert.equal(loadPairState(ctx.home).grants[ctx.peer.machineId], undefined);
  assert.equal(loadLinkedTokens(ctx.home)[ctx.peer.machineId], undefined);
});

test("forget with a device-key signature also works, and revokeLocalGrant drops the saved token", async () => {
  const ctx = setup();
  const inbound = await approvedToken(ctx);
  const accessToken = "db_" + "11".repeat(32);
  const issuedAt = "2026-11-17T19:05:00.000Z";
  const offer = { hostId: "host-machine-0001", peerId: ctx.peer.machineId, accessToken, issuedAt };
  assert.equal(
    (await post(ctx, "/api/link/reciprocal", { offer, signature: signReciprocal(ctx.peerKeys.privateKey, offer) }, { authorization: `Bearer ${inbound}` })).status,
    200,
  );
  const forgotten = await post(ctx, "/api/link/forget", {
    fromId: ctx.peer.machineId,
    peerId: "host-machine-0001",
    issuedAt,
    signature: signForget(ctx.peerKeys.privateKey, { fromId: ctx.peer.machineId, peerId: "host-machine-0001", issuedAt }),
  });
  assert.equal(forgotten.status, 200, Buffer.from(forgotten.body).toString());
  assert.equal(loadLinkedTokens(ctx.home)[ctx.peer.machineId], undefined);
});

test("browse helpers build a phone root URL and normalize paths", () => {
  assert.equal(normalizePath("/Download/file.txt"), "/Download/file.txt");
  assert.equal(normalizePath("/foo/../bar"), "/bar");
  const url = browseUrl({ type: "phone", tailscaleHost: "100.64.1.8", port: 8780, lanAddress: "", directInternet: false, publicHost: "" }, "/DCIM");
  assert.equal(url, "http://100.64.1.8:8780/DCIM");
});

test("listRemote maps a 207 propfind into entries and skips the requested folder", async () => {
  const xml = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">
    <D:response><D:href>/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>
    <D:response><D:href>/DCIM/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype><D:getlastmodified>Tue, 17 Nov 2026 19:00:00 GMT</D:getlastmodified></D:prop></D:propstat></D:response>
    <D:response><D:href>/note.txt</D:href><D:propstat><D:prop><D:getcontentlength>4</D:getcontentlength></D:prop></D:propstat></D:response>
  </D:multistatus>`;
  const listed = await listRemote({
    machine: { type: "phone", tailscaleHost: "100.64.1.8", port: 8780 },
    token: "db_" + "22".repeat(32),
    path: "/",
    fetchImpl: async () => new Response(xml, { status: 207 }),
  });
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.entries.map((row) => row.name), ["DCIM", "note.txt"]);
  assert.equal(listed.entries[0].directory, true);
  assert.equal(listed.entries[1].size, 4);
});
