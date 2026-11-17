/**
 * Machine-to-machine HTTP. The cloud is not on this path.
 * Pairing and WebDAV talk to the machine that holds the files.
 */

import path from "node:path";
import { isMountableHost } from "./phone-drive.mjs";
import { isLoopbackAddress } from "./loopback.mjs";
import { isTailnetAddress } from "./tailnet.mjs";
import {
  approveRequest,
  denyRequest,
  grantForToken,
  issueCode,
  pollRequest,
  randomRequestId,
  randomSalt,
  randomToken,
  redeemCode,
  startRequest,
  revokeGrant,
  verifyPairToken,
} from "./linked-machines.mjs";
import { verifyJoinRequest } from "./linked-join.mjs";
import { handleDav } from "./linked-dav.mjs";
import { loadIdentity, loadLinkedTokens, loadPairState, loadShares, saveLinkedTokens, savePairState } from "./linked-store.mjs";
import { acceptReciprocalOffer, applyForget } from "./linked-reciprocal.mjs";
import { honorAttestation, publicPendingList, makeAttestation, spreadHonoredApproval, verifyAttestation } from "./linked-sponsor.mjs";
import { loadDek } from "./linked-vault.mjs";
import {
  formatCountdown,
  nextRemoteAccess,
  publicWriteAllowed,
  readRemoteAccessFile,
  remoteAccessBanner,
  requestReach,
  writeRemoteAccessFile,
} from "./public-access.mjs";

function json(status, value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  return {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": String(body.length),
    },
    body,
  };
}

function readObject(body) {
  try {
    const parsed = JSON.parse(Buffer.from(body || "").toString("utf8") || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return null;
  }
}

function privatePeer(address) {
  return isMountableHost(address);
}

function accessPath(home, accessFile) {
  return accessFile || (home ? path.join(home, "public-access.json") : "");
}

function pairTokenFrom(headers, payload) {
  const headerMap = {};
  for (const [key, value] of Object.entries(headers || {})) headerMap[key.toLowerCase()] = value;
  const auth = String(headerMap.authorization || "");
  const bearer = /^Bearer\s+(\S+)$/i.exec(auth);
  if (bearer) return bearer[1];
  if (payload && payload.token) return String(payload.token);
  const basic = auth;
  return "";
}

export async function handleLinkedHttp({
  method,
  path,
  headers = {},
  body = Buffer.alloc(0),
  remoteAddress = "",
  home,
  now = Date.now(),
  accessFile,
  reachMode = "both",
  fullAccess = null,
  joinDeps = {},
}) {
  const verb = String(method || "GET").toUpperCase();
  const pathname = String(path || "").split("?")[0];
  const knownPeer = String(remoteAddress || "").trim();
  if (pathname === "/dav" || pathname.startsWith("/dav/")) {
    const shares = loadShares(home);
    const identity = loadIdentity(home);
    const access = accessPath(home, accessFile) ? readRemoteAccessFile(accessPath(home, accessFile), now) : { enabled: false, mode: "" };
    if (requestReach(reachMode, knownPeer, access, now) === "deny") {
      const body = Buffer.from("Public access is off", "utf8");
      return {
        status: 403,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          "content-length": String(body.length),
        },
        body,
      };
    }
    const writeOk = publicWriteAllowed(reachMode, knownPeer, access, now);
    return handleDav({
      method: verb,
      urlPath: pathname,
      headers,
      body: Buffer.isBuffer(body) ? body : Buffer.from(body || ""),
      shares,
      pairState: loadPairState(home),
      // A missing socket address still needs a pair token. A known public address does not.
      remoteIsPrivate: !knownPeer || privatePeer(knownPeer),
      directInternet: shares.directInternet === true,
      displayName: identity?.displayName || "Drivebay",
      publicWrite: writeOk,
      fullAccess: typeof fullAccess === "function" ? await fullAccess() : fullAccess,
    });
  }
  if (!pathname.startsWith("/api/link/")) return null;
  if (!home) return json(503, { error: "This machine has no data folder." });
  const linkAccess = accessPath(home, accessFile) ? readRemoteAccessFile(accessPath(home, accessFile), now) : { enabled: false, mode: "" };
  if (requestReach(reachMode, knownPeer, linkAccess, now) === "deny") {
    return json(403, { error: "Public access is off" });
  }
  const shares = loadShares(home);
  const pairAllowed = knownPeer && (privatePeer(knownPeer) || shares.directInternet === true);
  if (!pairAllowed) {
    return json(403, { error: "Pairing is only accepted from Tailscale, LAN, or this machine." });
  }

  if (pathname === "/api/link/whoami" && verb === "GET") {
    const identity = loadIdentity(home);
    if (!identity?.machineId || !identity.publicKey) return json(404, { error: "This machine has not registered yet." });
    return json(200, {
      machineId: identity.machineId,
      displayName: identity.displayName || "",
      publicKey: identity.publicKey,
    });
  }

  const payload = readObject(body);
  if (!payload) return json(400, { error: "Expected JSON." });
  let state = loadPairState(home);

  if (pathname === "/api/link/redeem" && verb === "POST") {
    const token = randomToken();
    const result = redeemCode(state, {
      code: String(payload.code || ""),
      peerId: String(payload.machineId || ""),
      name: String(payload.displayName || ""),
      now,
      token,
      tokenSalt: randomSalt(),
    });
    savePairState(home, result.state);
    if (!result.ok) return json(403, { error: result.error });
    return json(200, { token: result.token });
  }

  if (pathname === "/api/link/request" && verb === "POST") {
    const id = randomRequestId();
    const secret = String(payload.secret || "");
    if (secret.length < 16) return json(400, { error: "The request secret is missing." });
    const fromId = String(payload.machineId || "");
    // A join request carries the join password proof and a device-key signature. A bad one is
    // refused outright so the user is not asked to approve something that can never be trusted.
    let verified = false;
    let publicKey = "";
    if (payload.proof || payload.signature) {
      const checked = await verifyJoinRequest({
        home,
        peerId: fromId,
        secret,
        proof: String(payload.proof || ""),
        signature: String(payload.signature || ""),
        ...joinDeps,
      });
      if (!checked.ok) {
        const message = {
          "bad-password": "The join password did not match.",
          "host-locked": "Unlock the machine list on this computer first.",
          "host-unregistered": "This computer has not registered yet.",
          "not-on-login": "That machine is not on this Mesa and Moon login.",
          "bad-device-key": "That machine's device key did not match the account.",
        }[checked.reason] || "The join request was refused.";
        return json(403, { error: message, reason: checked.reason });
      }
      verified = true;
      publicKey = checked.publicKey || "";
    }
    state = startRequest(state, {
      id,
      fromId,
      name: String(payload.displayName || "Machine"),
      secret,
      salt: randomSalt(),
      now,
      verified,
      publicKey,
    });
    savePairState(home, state);
    const stored = (state.pending || [])[state.pending.length - 1];
    return json(200, { id: stored?.id || id, join: verified });
  }

  if (pathname === "/api/link/poll" && verb === "POST") {
    const result = pollRequest(state, { id: String(payload.id || ""), secret: String(payload.secret || "") });
    if (result.ok) savePairState(home, result.state);
    if (!result.ok) return json(409, { error: result.error, missing: result.missing === true });
    return json(200, { token: result.token, scope: result.scope || "shares" });
  }

  if (pathname === "/api/link/remote-access" && (verb === "GET" || verb === "POST")) {
    const file = accessPath(home, accessFile);
    const loopback = isLoopbackAddress(knownPeer);
    const tailscale = isTailnetAddress(knownPeer);
    const token = pairTokenFrom(headers, payload);
    const paired = token && verifyPairToken(state, token);
    if (!loopback && !paired) return json(401, { error: "Pair this device with that computer first." });
    if (verb === "GET") {
      const current = file ? readRemoteAccessFile(file, now) : { enabled: false, offAt: null };
      const banner = remoteAccessBanner(current, now);
      return json(200, {
        ok: true,
        enabled: current.enabled === true,
        offAt: current.offAt,
        mode: current.mode || "",
        source: current.source || "",
        byName: current.byName || "",
        countdown: banner && banner.remainingMs != null ? formatCountdown(banner.remainingMs) : "",
        title: banner ? banner.title : "",
        banner: banner ? banner.message : "",
      });
    }
    if (!loopback && !tailscale) {
      return json(403, { error: "Turn remote access on from a device that is already on the Tailscale network." });
    }
    if (reachMode === "tailscale") {
      return json(409, { error: "This computer is in Tailscale-only mode. Set it to Both on that computer first." });
    }
    const enabled = payload.enabled === true;
    let next;
    try {
      next = enabled
        ? nextRemoteAccess({
            enabled: true,
            minutes: Number(payload.minutes),
            mode: payload.mode === "ro" ? "ro" : "rw",
            now,
            source: loopback ? "local" : "remote",
            byMachineId: String(payload.machineId || ""),
            byName: String(payload.displayName || ""),
          })
        : nextRemoteAccess({ enabled: false, minutes: 15, mode: "rw", now });
    } catch (err) {
      return json(400, { error: err.message || "Choose a time limit." });
    }
    writeRemoteAccessFile(file, next);
    const banner = remoteAccessBanner(next, now);
    return json(200, {
      ok: true,
      enabled: next.enabled === true,
      offAt: next.offAt,
      mode: next.mode || "",
      source: next.source || "",
      byName: next.byName || "",
      countdown: banner && banner.remainingMs != null ? formatCountdown(banner.remainingMs) : "",
      title: banner ? banner.title : "",
      banner: banner ? banner.message : "",
    });
  }

  if (pathname === "/api/link/reciprocal" && verb === "POST") {
    const inbound = pairTokenFrom(headers, payload);
    const offer = payload.offer && typeof payload.offer === "object" ? payload.offer : payload;
    const identity = loadIdentity(home);
    const accepted = acceptReciprocalOffer({
      state,
      selfId: identity?.machineId || "",
      inboundToken: inbound,
      offer: {
        hostId: String(offer.hostId || ""),
        peerId: String(offer.peerId || ""),
        accessToken: String(offer.accessToken || ""),
        issuedAt: String(offer.issuedAt || ""),
      },
      signature: String(payload.signature || ""),
    });
    if (!accepted.ok) return json(403, { error: accepted.error });
    const records = loadLinkedTokens(home);
    const existing = records[accepted.peerId] || {};
    records[accepted.peerId] = {
      ...existing,
      token: accepted.accessToken,
      scope: "full",
      label: existing.label || accepted.name || "",
      reciprocal: true,
    };
    saveLinkedTokens(home, records);
    return json(200, { ok: true, machineId: accepted.peerId, scope: "full" });
  }

  if (pathname === "/api/link/forget" && verb === "POST") {
    const inbound = pairTokenFrom(headers, payload);
    const identity = loadIdentity(home);
    const forgotten = applyForget({
      state,
      selfId: identity?.machineId || "",
      inboundToken: inbound,
      fromId: String(payload.fromId || ""),
      peerId: String(payload.peerId || identity?.machineId || ""),
      signature: String(payload.signature || ""),
      issuedAt: String(payload.issuedAt || ""),
    });
    if (!forgotten.ok) return json(403, { error: forgotten.error });
    savePairState(home, forgotten.state);
    if (forgotten.dropId) {
      const records = loadLinkedTokens(home);
      if (records[forgotten.dropId]) {
        delete records[forgotten.dropId];
        saveLinkedTokens(home, records);
      }
    }
    return json(200, { ok: true });
  }

  if (pathname === "/api/link/pending" && verb === "GET") {
    const trusted = grantForToken(state, pairTokenFrom(headers, payload));
    if (!trusted || trusted.scope !== "full") return json(403, { error: "Only a trusted device can read join requests." });
    const identity = loadIdentity(home);
    return json(200, publicPendingList(state, { hostId: identity?.machineId || "", displayName: identity?.displayName || "" }));
  }

  if (pathname === "/api/link/approve" && verb === "POST") {
    const trusted = grantForToken(state, pairTokenFrom(headers, payload));
    if (!trusted || trusted.scope !== "full") return json(403, { error: "Only a trusted device can approve a join request." });
    const id = String(payload.id || "");
    const attestation = payload.attestation && typeof payload.attestation === "object" ? payload.attestation : null;
    if (!attestation) return json(400, { error: "This approval must be signed by a trusted device." });
    const dek = loadDek(home);
    const checked = verifyAttestation(attestation, { dek, approverPublicKey: trusted.publicKey });
    if (!checked.ok) return json(403, { error: checked.error || "The approval signature did not check out." });
    if (checked.approverId !== trusted.peerId) return json(403, { error: "That approval is not from this trusted device." });
    if (checked.requestId !== id) return json(403, { error: "That approval is not for this join request." });
    const result = approveLocalRequest(home, id, now);
    if (!result.ok) return json(409, { error: result.error || "Could not approve." });
    const identity = loadIdentity(home);
    if (identity?.privateKey && dek) {
      const hostAttestation = makeAttestation({
        dek,
        privateKey: identity.privateKey,
        approverId: identity.machineId,
        joinerId: checked.joinerId,
        joinerName: String(attestation.joinerName || ""),
        joinerPublicKey: String(attestation.joinerPublicKey || ""),
        requestId: id,
        hostId: identity.machineId,
      });
      void spreadHonoredApproval(home, hostAttestation).catch(() => {});
    }
    return json(200, { ok: true });
  }

  if (pathname === "/api/link/deny" && verb === "POST") {
    const trusted = grantForToken(state, pairTokenFrom(headers, payload));
    if (!trusted || trusted.scope !== "full") return json(403, { error: "Only a trusted device can deny a join request." });
    const denied = denyLocalRequest(home, String(payload.id || ""));
    if (!denied.ok) return json(409, { error: denied.error || "Could not deny." });
    return json(200, { ok: true });
  }

  if (pathname === "/api/link/honor-approval" && verb === "POST") {
    const vault = await import("./linked-vault.mjs");
    const dek = vault.loadDek(home);
    const identity = loadIdentity(home);
    const attestation = payload.attestation && typeof payload.attestation === "object" ? payload.attestation : payload;
    const approverId = String(attestation.approverId || "");
    const trusted = state?.grants?.[approverId];
    const approverPublicKey = trusted?.publicKey || "";
    const honored = honorAttestation(state, {
      attestation,
      dek,
      selfId: identity?.machineId || "",
      approverPublicKey,
      joinerPublicKey: String(attestation.joinerPublicKey || ""),
      now,
    });
    if (!honored.ok) return json(403, { error: honored.error || "Could not honor that approval." });
    if (!honored.already) savePairState(home, honored.state);
    return json(200, { ok: true, already: honored.already === true, joinerId: honored.joinerId || "" });
  }

  return json(404, { error: "Unknown link method." });
}

export function approveLocalRequest(home, id, now = Date.now()) {
  const state = loadPairState(home);
  const token = randomToken();
  const result = approveRequest(state, id, { token, tokenSalt: randomSalt(), now });
  if (!result.ok) return result;
  savePairState(home, result.state);
  return { ok: true };
}

export function denyLocalRequest(home, id) {
  const result = denyRequest(loadPairState(home), String(id || ""));
  if (!result.ok) return result;
  savePairState(home, result.state);
  return { ok: true };
}

export function revokeLocalGrant(home, peerId) {
  const id = String(peerId || "");
  const result = revokeGrant(loadPairState(home), id);
  if (!result.ok) return result;
  savePairState(home, result.state);
  const records = loadLinkedTokens(home);
  if (records[id]) {
    delete records[id];
    saveLinkedTokens(home, records);
  }
  return { ok: true, dropId: id };
}

export function issueLocalCode(home, code, now = Date.now()) {
  const state = issueCode(loadPairState(home), { code, salt: randomSalt(), now });
  savePairState(home, state);
  return { ok: true, code, expiresAt: state.code.expiresAt };
}
