import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { joinProof, newDek, signJoin } from "../app/src/lib/files/linked-crypto.mjs";
import { approveLocalRequest, handleLinkedHttp } from "../app/src/lib/files/linked-http.mjs";
import {
  addGrant,
  newMachineKeys,
  publicPairState,
  randomSalt,
  randomToken,
} from "../app/src/lib/files/linked-machines.mjs";
import { saveIdentity, savePairState, loadPairState } from "../app/src/lib/files/linked-store.mjs";
import {
  honorAttestation,
  makeAttestation,
  verifyAttestation,
} from "../app/src/lib/files/linked-sponsor.mjs";
import { wrapWithDeviceKey } from "../app/src/lib/files/linked-crypto.mjs";
import { saveVaultFile } from "../app/src/lib/files/linked-vault.mjs";

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rememberDek(home, dek, keys, machineId) {
  // loadDek unwraps the device wrap with the machine private key.
  saveVaultFile(home, {
    version: 2,
    hasPassphrase: true,
    hasRecovery: true,
    hasPasskey: false,
    deviceWrap: wrapWithDeviceKey(dek, keys.privateKey, machineId),
    createdAt: new Date().toISOString(),
  });
}

test("a trusted device can list and approve a pending join, and a shares-only token cannot", async () => {
  const home = tmp("db-sponsor-host-");
  const hostKeys = newMachineKeys();
  const phoneKeys = newMachineKeys();
  const pcKeys = newMachineKeys();
  const dek = newDek();
  saveIdentity(home, { machineId: "host-mac-00000001", displayName: "Mac", ...hostKeys });
  rememberDek(home, dek, hostKeys, "host-mac-00000001");
  const phoneToken = randomToken();
  const shareToken = randomToken();
  let state = { grants: {}, pending: [], code: null };
  state = addGrant(state, {
    peerId: "phone-trusted-00002",
    name: "Phone",
    token: phoneToken,
    tokenSalt: randomSalt(),
    now: 1,
    scope: "full",
    publicKey: phoneKeys.publicKey,
  });
  state = addGrant(state, {
    peerId: "guest-share-0000003",
    name: "Guest",
    token: shareToken,
    tokenSalt: randomSalt(),
    now: 1,
    scope: "shares",
  });
  savePairState(home, state);

  const peers = {
    "phone-trusted-00002": { machineId: "phone-trusted-00002", publicKey: phoneKeys.publicKey },
    "pc-joining-00000004": { machineId: "pc-joining-00000004", publicKey: pcKeys.publicKey },
  };
  const joinDeps = { dek, lookupPeer: async (_home, id) => peers[id] || null };

  const secret = randomToken();
  const parts = { hostId: "host-mac-00000001", peerId: "pc-joining-00000004", secret };
  const asked = await handleLinkedHttp({
    method: "POST",
    path: "/api/link/request",
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({
      machineId: "pc-joining-00000004",
      displayName: "DESKTOP-7OPHOTR",
      secret,
      proof: joinProof(dek, parts),
      signature: signJoin(pcKeys.privateKey, parts),
    })),
    remoteAddress: "100.64.0.9",
    home,
    joinDeps,
  });
  assert.equal(asked.status, 200);
  const requestId = JSON.parse(Buffer.from(asked.body).toString()).id;
  assert.equal(JSON.parse(Buffer.from(asked.body).toString()).join, true);

  const listed = await handleLinkedHttp({
    method: "GET",
    path: "/api/link/pending",
    headers: { authorization: `Bearer ${phoneToken}`, accept: "application/json" },
    body: Buffer.alloc(0),
    remoteAddress: "100.64.0.10",
    home,
    joinDeps,
  });
  assert.equal(listed.status, 200);
  const pendingBody = JSON.parse(Buffer.from(listed.body).toString());
  assert.equal(pendingBody.pending.length, 1);
  assert.equal(pendingBody.pending[0].name, "DESKTOP-7OPHOTR");
  assert.equal(pendingBody.pending[0].join, true);

  const shareList = await handleLinkedHttp({
    method: "GET",
    path: "/api/link/pending",
    headers: { authorization: `Bearer ${shareToken}` },
    body: Buffer.alloc(0),
    remoteAddress: "100.64.0.11",
    home,
    joinDeps,
  });
  assert.equal(shareList.status, 403);

  const attestation = makeAttestation({
    dek,
    privateKey: phoneKeys.privateKey,
    approverId: "phone-trusted-00002",
    joinerId: "pc-joining-00000004",
    joinerName: "DESKTOP-7OPHOTR",
    joinerPublicKey: pcKeys.publicKey,
    requestId,
    hostId: "host-mac-00000001",
  });
  const checked = verifyAttestation(attestation, { dek, approverPublicKey: phoneKeys.publicKey });
  assert.equal(checked.ok, true);

  const approved = await handleLinkedHttp({
    method: "POST",
    path: "/api/link/approve",
    headers: { authorization: `Bearer ${phoneToken}`, "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ id: requestId, attestation })),
    remoteAddress: "100.64.0.10",
    home,
    joinDeps,
  });
  assert.equal(approved.status, 200, Buffer.from(approved.body).toString());

  const polled = await handleLinkedHttp({
    method: "POST",
    path: "/api/link/poll",
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ id: requestId, secret })),
    remoteAddress: "100.64.0.9",
    home,
    joinDeps,
  });
  assert.equal(polled.status, 200);
  const pollBody = JSON.parse(Buffer.from(polled.body).toString());
  assert.equal(pollBody.scope, "full");
  assert.match(pollBody.token, /^dbp_[0-9a-f]{64}$/);
  fs.rmSync(home, { recursive: true, force: true });
});

test("deny from a trusted device drops the request without issuing a grant", async () => {
  const home = tmp("db-sponsor-deny-");
  const hostKeys = newMachineKeys();
  const phoneKeys = newMachineKeys();
  const pcKeys = newMachineKeys();
  const dek = newDek();
  saveIdentity(home, { machineId: "host-mac-00000001", displayName: "Mac", ...hostKeys });
  rememberDek(home, dek, hostKeys, "host-mac-00000001");
  const phoneToken = randomToken();
  savePairState(home, addGrant({ grants: {}, pending: [], code: null }, {
    peerId: "phone-trusted-00002",
    name: "Phone",
    token: phoneToken,
    tokenSalt: randomSalt(),
    now: 1,
    scope: "full",
    publicKey: phoneKeys.publicKey,
  }));
  const peers = {
    "pc-joining-00000004": { machineId: "pc-joining-00000004", publicKey: pcKeys.publicKey },
  };
  const joinDeps = { dek, lookupPeer: async (_home, id) => peers[id] || null };
  const secret = randomToken();
  const parts = { hostId: "host-mac-00000001", peerId: "pc-joining-00000004", secret };
  const asked = await handleLinkedHttp({
    method: "POST",
    path: "/api/link/request",
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({
      machineId: "pc-joining-00000004",
      displayName: "PC",
      secret,
      proof: joinProof(dek, parts),
      signature: signJoin(pcKeys.privateKey, parts),
    })),
    remoteAddress: "100.64.0.9",
    home,
    joinDeps,
  });
  const requestId = JSON.parse(Buffer.from(asked.body).toString()).id;
  const denied = await handleLinkedHttp({
    method: "POST",
    path: "/api/link/deny",
    headers: { authorization: `Bearer ${phoneToken}`, "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ id: requestId })),
    remoteAddress: "100.64.0.10",
    home,
    joinDeps,
  });
  assert.equal(denied.status, 200);
  assert.equal(publicPairState(loadPairState(home)).pending.length, 0);
  const polled = await handleLinkedHttp({
    method: "POST",
    path: "/api/link/poll",
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ id: requestId, secret })),
    remoteAddress: "100.64.0.9",
    home,
    joinDeps,
  });
  assert.equal(polled.status, 409);
  fs.rmSync(home, { recursive: true, force: true });
});

test("honoring a signed approval issues a full grant when this device already trusts the approver", () => {
  const dek = newDek();
  const approver = newMachineKeys();
  const joiner = newMachineKeys();
  const approval = makeAttestation({
    dek,
    privateKey: approver.privateKey,
    approverId: "phone-trusted-00002",
    joinerId: "pc-joining-00000004",
    joinerName: "PC",
    joinerPublicKey: joiner.publicKey,
    requestId: "req-honor-00000001",
    hostId: "host-mac-00000001",
  });
  let state = addGrant({ grants: {}, pending: [], code: null }, {
    peerId: "phone-trusted-00002",
    name: "Phone",
    token: randomToken(),
    tokenSalt: randomSalt(),
    now: 1,
    scope: "full",
    publicKey: approver.publicKey,
  });
  const honored = honorAttestation(state, {
    attestation: approval,
    dek,
    selfId: "other-desktop-0003",
    approverPublicKey: approver.publicKey,
    joinerPublicKey: joiner.publicKey,
    now: 2,
  });
  assert.equal(honored.ok, true);
  assert.equal(honored.state.grants["pc-joining-00000004"].scope, "full");
  const untrusted = honorAttestation({ grants: {}, pending: [], code: null }, {
    attestation: approval,
    dek,
    selfId: "other-desktop-0003",
    approverPublicKey: approver.publicKey,
    joinerPublicKey: joiner.publicKey,
    now: 2,
  });
  assert.equal(untrusted.ok, false);
});


test("an already-trusted machine is auto-granted on Join, with no approval prompt", async () => {
  const home = tmp("db-auto-trusted-");
  const hostKeys = newMachineKeys();
  const pcKeys = newMachineKeys();
  const dek = newDek();
  saveIdentity(home, { machineId: "host-mac-00000001", displayName: "Mac", ...hostKeys });
  rememberDek(home, dek, hostKeys, "host-mac-00000001");
  const existing = randomToken();
  savePairState(home, addGrant({ grants: {}, pending: [], code: null }, {
    peerId: "pc-joining-00000004",
    name: "DESKTOP-7OPHOTR",
    token: existing,
    tokenSalt: randomSalt(),
    now: 1,
    scope: "full",
    publicKey: pcKeys.publicKey,
  }));
  const secret = randomToken();
  const parts = { hostId: "host-mac-00000001", peerId: "pc-joining-00000004", secret };
  const asked = await handleLinkedHttp({
    method: "POST",
    path: "/api/link/request",
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({
      machineId: "pc-joining-00000004",
      displayName: "DESKTOP-7OPHOTR",
      secret,
      proof: joinProof(dek, parts),
      signature: signJoin(pcKeys.privateKey, parts),
    })),
    remoteAddress: "100.64.0.9",
    home,
    joinDeps: { dek, lookupPeer: async () => ({ machineId: "pc-joining-00000004", publicKey: pcKeys.publicKey }) },
  });
  assert.equal(asked.status, 200);
  const body = JSON.parse(Buffer.from(asked.body).toString());
  assert.equal(body.granted, true);
  assert.equal(publicPairState(loadPairState(home)).pending.length, 0);
  const polled = await handleLinkedHttp({
    method: "POST",
    path: "/api/link/poll",
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ id: body.id, secret })),
    remoteAddress: "100.64.0.9",
    home,
  });
  assert.equal(polled.status, 200);
  const pollBody = JSON.parse(Buffer.from(polled.body).toString());
  assert.equal(pollBody.scope, "full");
  assert.match(pollBody.token, /^dbp_[0-9a-f]{64}$/);
  fs.rmSync(home, { recursive: true, force: true });
});

test("a brand-new verified machine still waits for approval when it has no sponsor", async () => {
  const home = tmp("db-new-waits-");
  const hostKeys = newMachineKeys();
  const pcKeys = newMachineKeys();
  const dek = newDek();
  saveIdentity(home, { machineId: "host-mac-00000001", displayName: "Mac", ...hostKeys });
  rememberDek(home, dek, hostKeys, "host-mac-00000001");
  savePairState(home, { grants: {}, pending: [], code: null });
  const secret = randomToken();
  const parts = { hostId: "host-mac-00000001", peerId: "pc-joining-00000004", secret };
  const asked = await handleLinkedHttp({
    method: "POST",
    path: "/api/link/request",
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({
      machineId: "pc-joining-00000004",
      displayName: "DESKTOP-7OPHOTR",
      secret,
      proof: joinProof(dek, parts),
      signature: signJoin(pcKeys.privateKey, parts),
    })),
    remoteAddress: "100.64.0.9",
    home,
    joinDeps: { dek, lookupPeer: async () => ({ machineId: "pc-joining-00000004", publicKey: pcKeys.publicKey }) },
  });
  assert.equal(asked.status, 200);
  const body = JSON.parse(Buffer.from(asked.body).toString());
  assert.equal(body.join, true);
  assert.equal(body.granted, false);
  assert.equal(publicPairState(loadPairState(home)).pending.length, 1);
  fs.rmSync(home, { recursive: true, force: true });
});

test("a sponsor attestation from an already-trusted device auto-grants the joiner", async () => {
  const home = tmp("db-sponsored-");
  const hostKeys = newMachineKeys();
  const macKeys = newMachineKeys();
  const pcKeys = newMachineKeys();
  const dek = newDek();
  saveIdentity(home, { machineId: "phone-trusted-00002", displayName: "Phone", ...hostKeys });
  rememberDek(home, dek, hostKeys, "phone-trusted-00002");
  const macToken = randomToken();
  savePairState(home, addGrant({ grants: {}, pending: [], code: null }, {
    peerId: "host-mac-00000001",
    name: "Mac",
    token: macToken,
    tokenSalt: randomSalt(),
    now: 1,
    scope: "full",
    publicKey: macKeys.publicKey,
  }));
  const attestation = makeAttestation({
    dek,
    privateKey: macKeys.privateKey,
    approverId: "host-mac-00000001",
    joinerId: "pc-joining-00000004",
    joinerName: "DESKTOP-7OPHOTR",
    joinerPublicKey: pcKeys.publicKey,
    requestId: "sponsor:pc-joining-00000004",
    hostId: "host-mac-00000001",
  });
  const secret = randomToken();
  const parts = { hostId: "phone-trusted-00002", peerId: "pc-joining-00000004", secret };
  const asked = await handleLinkedHttp({
    method: "POST",
    path: "/api/link/request",
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({
      machineId: "pc-joining-00000004",
      displayName: "DESKTOP-7OPHOTR",
      secret,
      proof: joinProof(dek, parts),
      signature: signJoin(pcKeys.privateKey, parts),
      attestation,
    })),
    remoteAddress: "100.64.0.9",
    home,
    joinDeps: { dek, lookupPeer: async () => ({ machineId: "pc-joining-00000004", publicKey: pcKeys.publicKey }) },
  });
  assert.equal(asked.status, 200, Buffer.from(asked.body).toString());
  const body = JSON.parse(Buffer.from(asked.body).toString());
  assert.equal(body.granted, true);
  const polled = await handleLinkedHttp({
    method: "POST",
    path: "/api/link/poll",
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ id: body.id, secret })),
    remoteAddress: "100.64.0.9",
    home,
  });
  assert.equal(polled.status, 200);
  assert.equal(JSON.parse(Buffer.from(polled.body).toString()).scope, "full");
  fs.rmSync(home, { recursive: true, force: true });
});

test("a trusted machine can ask for a sponsor attestation for itself", async () => {
  const home = tmp("db-sponsor-ask-");
  const hostKeys = newMachineKeys();
  const pcKeys = newMachineKeys();
  const dek = newDek();
  saveIdentity(home, { machineId: "host-mac-00000001", displayName: "Mac", ...hostKeys });
  rememberDek(home, dek, hostKeys, "host-mac-00000001");
  const pcToken = randomToken();
  savePairState(home, addGrant({ grants: {}, pending: [], code: null }, {
    peerId: "pc-joining-00000004",
    name: "DESKTOP-7OPHOTR",
    token: pcToken,
    tokenSalt: randomSalt(),
    now: 1,
    scope: "full",
    publicKey: pcKeys.publicKey,
  }));
  const asked = await handleLinkedHttp({
    method: "POST",
    path: "/api/link/sponsor-attestation",
    headers: { authorization: `Bearer ${pcToken}`, "content-type": "application/json" },
    body: Buffer.from("{}"),
    remoteAddress: "100.64.0.9",
    home,
  });
  assert.equal(asked.status, 200, Buffer.from(asked.body).toString());
  const body = JSON.parse(Buffer.from(asked.body).toString());
  assert.equal(body.attestation.approverId, "host-mac-00000001");
  assert.equal(body.attestation.joinerId, "pc-joining-00000004");
  fs.rmSync(home, { recursive: true, force: true });
});
