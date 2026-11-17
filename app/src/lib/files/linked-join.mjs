/**
 * Host side of "join this login": check the join password proof and the device key
 * before a pending request is marked as an own-machine join.
 * Nothing here stores or logs the password, the DEK, or a token.
 */

import { verifyJoinProof, verifyJoinSignature } from "./linked-crypto.mjs";
import { loadIdentity } from "./linked-store.mjs";
import { loadDek } from "./linked-vault.mjs";

async function cloudPeer(home, peerId) {
  const cloud = await import("./linked-cloud.mjs");
  const listed = await cloud.fetchMachines(home);
  if (!listed?.ok || listed.needsUnlock) return null;
  return (listed.machines || []).find((row) => row?.machineId === peerId) || null;
}

/**
 * @returns {Promise<{ok: boolean, reason?: string}>}
 * ok means: the peer is a machine on this host's own login, it knows the join password,
 * and it owns the private key that matches the public key in the account directory.
 */
export async function verifyJoinRequest({
  home,
  peerId,
  secret,
  proof,
  signature,
  dek = loadDek(home),
  lookupPeer = cloudPeer,
  hostId = loadIdentity(home)?.machineId || "",
}) {
  if (!proof || !signature) return { ok: false, reason: "no-proof" };
  if (!dek) return { ok: false, reason: "host-locked" };
  if (!hostId) return { ok: false, reason: "host-unregistered" };
  const parts = { hostId, peerId, secret };
  if (!verifyJoinProof(dek, parts, proof)) return { ok: false, reason: "bad-password" };
  let peer = null;
  try {
    peer = await lookupPeer(home, peerId);
  } catch {
    peer = null;
  }
  if (!peer?.publicKey) return { ok: false, reason: "not-on-login" };
  if (!verifyJoinSignature(peer.publicKey, parts, signature)) return { ok: false, reason: "bad-device-key" };
  return { ok: true, publicKey: String(peer.publicKey) };
}
