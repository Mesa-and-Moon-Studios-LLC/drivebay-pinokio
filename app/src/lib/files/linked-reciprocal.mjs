/**
 * Reciprocal own-machine grants. After a trusted join is approved, the joiner
 * issues a token so the host can browse the joiner's drives too. The offer is
 * signed with the joiner's device key and is only accepted when the inbound
 * pair token already belongs to a full-scope grant. Forget on either side
 * ends both directions.
 * Tokens and keys are never logged.
 */

import crypto from "node:crypto";
import { grantForToken, revokeGrant } from "./linked-machines.mjs";

export const RECIPROCAL_PREFIX = "drivebay-reciprocal-v1";
export const FORGET_PREFIX = "drivebay-forget-v1";

export function looksLikeAccessToken(token) {
  return /^(db_|dbp_)[0-9a-f]{64}$/.test(String(token || ""));
}

export function reciprocalMessage({ hostId, peerId, accessToken, issuedAt }) {
  return Buffer.from(`${RECIPROCAL_PREFIX}\0${hostId}\0${peerId}\0${accessToken}\0${issuedAt}`, "utf8");
}

export function forgetMessage({ fromId, peerId, issuedAt }) {
  return Buffer.from(`${FORGET_PREFIX}\0${fromId}\0${peerId}\0${issuedAt}`, "utf8");
}

function signDevice(privateKeyB64, message) {
  const key = crypto.createPrivateKey({ key: Buffer.from(privateKeyB64, "base64"), format: "der", type: "pkcs8" });
  return crypto.sign(null, message, key).toString("base64");
}

function verifyDevice(publicKeyB64, message, signature) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(String(publicKeyB64), "base64"), format: "der", type: "spki" });
    return crypto.verify(null, message, key, Buffer.from(String(signature), "base64"));
  } catch {
    return false;
  }
}

export function signReciprocal(privateKeyB64, offer) {
  return signDevice(privateKeyB64, reciprocalMessage(offer));
}

export function verifyReciprocal(publicKeyB64, offer, signature) {
  return verifyDevice(publicKeyB64, reciprocalMessage(offer), signature);
}

export function signForget(privateKeyB64, parts) {
  return signDevice(privateKeyB64, forgetMessage(parts));
}

export function verifyForget(publicKeyB64, parts, signature) {
  return verifyDevice(publicKeyB64, forgetMessage(parts), signature);
}

/**
 * The joiner presents the inbound pair token (proving the host already approved it)
 * plus a device-key signature over the token the host should use to browse the joiner.
 */
export function acceptReciprocalOffer({ state, selfId, inboundToken, offer, signature }) {
  const grant = grantForToken(state, inboundToken);
  if (!grant || grant.scope !== "full") {
    return { ok: false, error: "Only a machine this computer already trusts can offer a reciprocal grant." };
  }
  const hostId = String(offer?.hostId || "");
  const peerId = String(offer?.peerId || "");
  const accessToken = String(offer?.accessToken || "");
  const issuedAt = String(offer?.issuedAt || "");
  if (grant.peerId !== peerId) return { ok: false, error: "That offer is not from the approved machine." };
  if (!selfId || hostId !== selfId) return { ok: false, error: "That offer is not for this machine." };
  if (!looksLikeAccessToken(accessToken)) return { ok: false, error: "The access token is not valid." };
  if (!issuedAt) return { ok: false, error: "The offer is missing a timestamp." };
  if (!grant.publicKey || !verifyReciprocal(grant.publicKey, { hostId, peerId, accessToken, issuedAt }, signature)) {
    return { ok: false, error: "The device key signature did not match." };
  }
  return { ok: true, peerId, name: grant.name || "", accessToken, scope: "full" };
}

/**
 * End the trust relationship. Accepted when the caller presents the inbound pair
 * token, or a device-key signature that matches the stored grant public key.
 */
export function applyForget({ state, selfId, inboundToken, fromId, peerId, signature, issuedAt }) {
  let targetId = "";
  if (inboundToken) {
    const grant = grantForToken(state, inboundToken);
    if (grant) targetId = grant.peerId;
  }
  if (!targetId && fromId && signature) {
    const grant = (state?.grants || {})[fromId];
    if (grant?.publicKey && verifyForget(grant.publicKey, { fromId, peerId: peerId || selfId, issuedAt }, signature)) {
      targetId = fromId;
    }
  }
  if (!targetId) return { ok: false, error: "That machine is not paired.", state, dropId: "" };
  const revoked = revokeGrant(state, targetId);
  if (!revoked.ok) return { ok: false, error: revoked.error, state, dropId: "" };
  return { ok: true, state: revoked.state, dropId: targetId };
}
