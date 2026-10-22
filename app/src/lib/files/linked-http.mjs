/**
 * Machine-to-machine HTTP. The cloud is not on this path.
 * Pairing and WebDAV talk to the machine that holds the files.
 */

import { isMountableHost } from "./phone-drive.mjs";
import {
  approveRequest,
  issueCode,
  pollRequest,
  randomRequestId,
  randomSalt,
  randomToken,
  redeemCode,
  startRequest,
} from "./linked-machines.mjs";
import { handleDav } from "./linked-dav.mjs";
import { loadIdentity, loadPairState, loadShares, savePairState } from "./linked-store.mjs";

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

export async function handleLinkedHttp({
  method,
  path,
  headers = {},
  body = Buffer.alloc(0),
  remoteAddress = "",
  home,
  now = Date.now(),
}) {
  const verb = String(method || "GET").toUpperCase();
  const pathname = String(path || "").split("?")[0];
  const knownPeer = String(remoteAddress || "").trim();
  if (pathname === "/dav" || pathname.startsWith("/dav/")) {
    const shares = loadShares(home);
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
    });
  }
  if (!pathname.startsWith("/api/link/")) return null;
  if (!home) return json(503, { error: "This machine has no data folder." });
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
    state = startRequest(state, {
      id,
      fromId: String(payload.machineId || ""),
      name: String(payload.displayName || "Machine"),
      secret,
      salt: randomSalt(),
      now,
    });
    savePairState(home, state);
    const stored = (state.pending || [])[state.pending.length - 1];
    return json(200, { id: stored?.id || id });
  }

  if (pathname === "/api/link/poll" && verb === "POST") {
    const result = pollRequest(state, { id: String(payload.id || ""), secret: String(payload.secret || "") });
    if (result.ok) savePairState(home, result.state);
    if (!result.ok) return json(409, { error: result.error });
    return json(200, { token: result.token });
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

export function issueLocalCode(home, code, now = Date.now()) {
  const state = issueCode(loadPairState(home), { code, salt: randomSalt(), now });
  savePairState(home, state);
  return { ok: true, code, expiresAt: state.code.expiresAt };
}
