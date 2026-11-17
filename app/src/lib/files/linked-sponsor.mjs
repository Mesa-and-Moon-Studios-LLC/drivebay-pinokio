/**
 * A trusted device can approve a pending join for the whole account.
 * The approval is signed with that device's key and proves it holds the
 * join-password key (DEK). Other trusted machines honor it by issuing their
 * own full grant. Tokens, the DEK, and private keys are never logged.
 */

import { joinProof, verifyJoinProof } from "./linked-crypto.mjs";
import { addGrant, randomSalt, randomToken } from "./linked-machines.mjs";
import { loadDek } from "./linked-vault.mjs";
import { loadIdentity, loadLinkedTokens, loadPairState, saveLinkedTokens, savePairState } from "./linked-store.mjs";
import crypto from "node:crypto";

export const APPROVAL_PREFIX = "drivebay-approval-v1";
export const SPONSORED_PREFIX = "drivebay-sponsored-v1";

export function approvalMessage({ approverId, joinerId, requestId, hostId, issuedAt }) {
  return Buffer.from(`${APPROVAL_PREFIX}\0${approverId}\0${joinerId}\0${requestId}\0${hostId}\0${issuedAt}`, "utf8");
}

export function sponsoredMessage({ fromId, joinerId, accessToken, issuedAt }) {
  return Buffer.from(`${SPONSORED_PREFIX}\0${fromId}\0${joinerId}\0${accessToken}\0${issuedAt}`, "utf8");
}

function signRaw(privateKeyB64, message) {
  const key = crypto.createPrivateKey({ key: Buffer.from(privateKeyB64, "base64"), format: "der", type: "pkcs8" });
  return crypto.sign(null, message, key).toString("base64");
}

function verifyRaw(publicKeyB64, message, signature) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(String(publicKeyB64), "base64"), format: "der", type: "spki" });
    return crypto.verify(null, message, key, Buffer.from(String(signature), "base64"));
  } catch {
    return false;
  }
}

/** Bind the approval to the join-password key without sending the password or the DEK. */
export function approvalProofParts({ approverId, joinerId, requestId }) {
  return { hostId: String(approverId || ""), peerId: String(joinerId || ""), secret: `approve:${requestId}` };
}

export function signApproval(privateKeyB64, parts) {
  return signRaw(privateKeyB64, approvalMessage(parts));
}

export function verifyApproval(publicKeyB64, parts, signature) {
  return verifyRaw(publicKeyB64, approvalMessage(parts), signature);
}

export function signSponsored(privateKeyB64, parts) {
  return signRaw(privateKeyB64, sponsoredMessage(parts));
}

export function verifySponsored(publicKeyB64, parts, signature) {
  return verifyRaw(publicKeyB64, sponsoredMessage(parts), signature);
}

export function makeAttestation({
  dek,
  privateKey,
  approverId,
  joinerId,
  joinerName = "",
  joinerPublicKey = "",
  requestId,
  hostId,
  issuedAt = new Date().toISOString(),
}) {
  const proof = joinProof(dek, approvalProofParts({ approverId, joinerId, requestId }));
  const signature = signApproval(privateKey, { approverId, joinerId, requestId, hostId, issuedAt });
  return { approverId, joinerId, joinerName, joinerPublicKey, requestId, hostId, issuedAt, proof, signature };
}

export function verifyAttestation(attestation, { dek, approverPublicKey }) {
  const approverId = String(attestation?.approverId || "");
  const joinerId = String(attestation?.joinerId || "");
  const requestId = String(attestation?.requestId || "");
  const hostId = String(attestation?.hostId || "");
  const issuedAt = String(attestation?.issuedAt || "");
  if (!approverId || !joinerId || !requestId || !hostId || !issuedAt) return { ok: false, error: "The approval is missing fields." };
  if (!dek) return { ok: false, error: "Unlock the machine list on this device first." };
  if (!verifyJoinProof(dek, approvalProofParts({ approverId, joinerId, requestId }), attestation.proof)) {
    return { ok: false, error: "The join password proof on that approval did not match." };
  }
  if (!approverPublicKey || !verifyApproval(approverPublicKey, { approverId, joinerId, requestId, hostId, issuedAt }, attestation.signature)) {
    return { ok: false, error: "The approving device's signature did not match." };
  }
  const age = Date.now() - Date.parse(issuedAt);
  if (!Number.isFinite(age) || age > 30 * 60 * 1000 || age < -60 * 1000) {
    return { ok: false, error: "That approval has expired." };
  }
  return { ok: true, approverId, joinerId, hostId, requestId, issuedAt };
}

export function looksLikeAccessToken(token) {
  return /^(db_|dbp_)[0-9a-f]{64}$/.test(String(token || ""));
}

/**
 * Another trusted machine already approved this joiner. If this device also
 * trusts the approver, issue a full grant for the joiner.
 */
export function honorAttestation(state, { attestation, dek, selfId, approverPublicKey, joinerPublicKey, now = Date.now() }) {
  const checked = verifyAttestation(attestation, { dek, approverPublicKey });
  if (!checked.ok) return checked;
  if (checked.approverId === selfId) return { ok: false, error: "This machine should approve the local request instead." };
  const trusted = state?.grants?.[checked.approverId];
  const trustedByKey = trusted?.scope === "full";
  if (!trustedByKey) return { ok: false, error: "Only a machine this device already trusts can sponsor a join." };
  if (trusted.publicKey && approverPublicKey && trusted.publicKey !== approverPublicKey) {
    return { ok: false, error: "The approving device's key did not match the trusted grant." };
  }
  const joinerId = checked.joinerId;
  if (joinerId === selfId) return { ok: false, error: "A machine cannot sponsor a grant to itself." };
  if (state?.grants?.[joinerId]?.scope === "full") {
    return { ok: true, already: true, joinerId, state };
  }
  const token = randomToken();
  const tokenSalt = randomSalt();
  const granted = addGrant(state, {
    peerId: joinerId,
    name: String(attestation.joinerName || "Machine"),
    token,
    tokenSalt,
    now,
    scope: "full",
    publicKey: joinerPublicKey || "",
  });
  return { ok: true, joinerId, token, state: granted };
}

/** Public pending rows only. Never include secrets, hashes, or tokens. */
export function publicPendingList(state, { hostId = "", displayName = "" } = {}) {
  return {
    hostId,
    displayName,
    pending: (state?.pending || [])
      .filter((row) => !row.token)
      .map((row) => ({
        id: row.id,
        fromId: row.fromId,
        name: row.name,
        at: row.at,
        join: row.verified === true,
      })),
  };
}

export function issueLocalSponsoredGrant(home, { joinerId, joinerName = "", joinerPublicKey = "", now = Date.now() }) {
  const state = loadPairState(home);
  const self = loadIdentity(home);
  if (!self?.machineId || joinerId === self.machineId) return { ok: false, error: "Cannot issue a grant to this machine." };
  if (state?.grants?.[joinerId]?.scope === "full") return { ok: true, already: true, state };
  const token = randomToken();
  const next = addGrant(state, {
    peerId: joinerId,
    name: joinerName || "Machine",
    token,
    tokenSalt: randomSalt(),
    now,
    scope: "full",
    publicKey: joinerPublicKey || "",
  });
  savePairState(home, next);
  return { ok: true, token, state: next };
}

function tokenOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/** Pending join requests on other trusted desktops this device already has a full grant to. */
export async function listRemotePending(home, fetchImpl = fetch) {
  const records = loadLinkedTokens(home);
  const out = [];
  for (const [machineId, row] of Object.entries(records || {})) {
    if (!row?.token || row.scope !== "full" || !row.url) continue;
    const origin = tokenOrigin(row.url);
    if (!origin) continue;
    try {
      const res = await fetchImpl(`${origin}/api/link/pending`, {
        headers: { authorization: `Bearer ${row.token}`, accept: "application/json" },
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok) continue;
      const body = await res.json();
      for (const item of body.pending || []) {
        if (!item?.id) continue;
        out.push({
          id: item.id,
          fromId: item.fromId || "",
          name: item.name || "",
          at: item.at,
          join: item.join === true,
          hostId: body.hostId || machineId,
          hostName: body.displayName || "",
          hostUrl: origin,
        });
      }
    } catch {
      /* that machine is offline or not yet running this build */
    }
  }
  return out;
}

/** Ask every other reachable trusted machine to issue the joiner a full grant. */
export async function spreadHonoredApproval(home, attestation, fetchImpl = fetch) {
  try {
    const cloud = await import("./linked-cloud.mjs");
    const machines = await import("./linked-machines.mjs");
    const listed = await cloud.fetchMachines(home);
    if (!listed?.ok || listed.needsUnlock) return { sent: 0 };
    const selfId = loadIdentity(home)?.machineId || "";
    const records = loadLinkedTokens(home);
    let sent = 0;
    for (const machine of listed.machines || []) {
      if (!machine?.machineId || machine.machineId === selfId || machine.machineId === attestation.joinerId) continue;
      const target = machines.connectionUrl(machine);
      if (!target.url || target.risk) continue;
      const origin = tokenOrigin(target.url);
      if (!origin) continue;
      const token = records[machine.machineId]?.token || "";
      const headers = { "content-type": "application/json", accept: "application/json" };
      if (token) headers.authorization = `Bearer ${token}`;
      try {
        const res = await fetchImpl(`${origin}/api/link/honor-approval`, {
          method: "POST",
          headers,
          body: JSON.stringify({ attestation }),
          signal: AbortSignal.timeout(4000),
        });
        if (res.ok) sent += 1;
      } catch {
        /* offline */
      }
    }
    return { sent };
  } catch {
    return { sent: 0 };
  }
}

/** A full grant whose stored key, if any, matches the caller. */
export function alreadyTrustedGrant(state, peerId, publicKey = "") {
  const grant = state?.grants?.[peerId];
  if (!grant || grant.scope !== "full") return null;
  if (publicKey && grant.publicKey && grant.publicKey !== publicKey) return null;
  return grant;
}

/**
 * A join from a machine this host already trusts, or one a trusted device has
 * already approved, can be granted immediately. Brand-new devices still wait.
 */
export function sponsoredJoinAllowed(state, { attestation, dek, selfId, joinerId, joinerPublicKey = "" }) {
  if (!attestation || typeof attestation !== "object") return { ok: false, error: "No sponsor approval was sent." };
  const approverId = String(attestation.approverId || "");
  const trusted = alreadyTrustedGrant(state, approverId);
  if (!trusted) return { ok: false, error: "Only a machine this device already trusts can sponsor a join." };
  const checked = verifyAttestation(attestation, { dek, approverPublicKey: trusted.publicKey });
  if (!checked.ok) return checked;
  if (checked.joinerId !== joinerId) return { ok: false, error: "That approval is not for this machine." };
  if (checked.approverId === selfId) return { ok: false, error: "This machine should approve the local request instead." };
  if (joinerPublicKey && attestation.joinerPublicKey && attestation.joinerPublicKey !== joinerPublicKey) {
    return { ok: false, error: "The sponsored key did not match this machine." };
  }
  return { ok: true };
}
