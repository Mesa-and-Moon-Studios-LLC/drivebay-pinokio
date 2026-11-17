/**
 * After two devices are already trusted on the same login, Join or Connect
 * pairs them immediately and existing pairs backfill missing grants both ways.
 * Tokens and keys are never logged.
 */

import { loadIdentity, loadLinkedTokens, loadPairState, saveLinkedTokens, savePairState } from "./linked-store.mjs";
import { addGrant, connectionCandidates, isOnline, pickDriveLetter, randomSalt, randomToken } from "./linked-machines.mjs";
import { joinProof, signJoin } from "./linked-crypto.mjs";
import { fetchSponsorAttestation, offerReciprocalRemote, pollRemote, requestRemote } from "./linked-connect.mjs";
import { signReciprocal } from "./linked-reciprocal.mjs";

function hasFullToken(records, machineId) {
  const row = records?.[machineId];
  return Boolean(row?.token && row.scope === "full");
}

async function sponsorAttestation(home, records, selfId, fetchImpl) {
  for (const [machineId, row] of Object.entries(records || {})) {
    if (machineId === selfId || !row?.token || row.scope !== "full" || !row.url) continue;
    const asked = await fetchSponsorAttestation({ url: row.url, token: row.token, fetchImpl }).catch(() => null);
    if (asked?.ok) return asked.attestation;
  }
  return null;
}

async function offerReciprocal(home, machineId, url, inboundToken, displayName, fetchImpl) {
  const self = loadIdentity(home);
  if (!self?.privateKey || !self.machineId || !inboundToken) return;
  let state = loadPairState(home);
  let grant = state?.grants?.[machineId];
  let accessToken = "";
  if (grant?.scope === "full") {
    // A fresh token is issued so the peer can store one; the previous grant stays valid.
    accessToken = randomToken();
    state = addGrant(state, {
      peerId: machineId,
      name: displayName || grant.name || "Machine",
      token: accessToken,
      tokenSalt: randomSalt(),
      now: Date.now(),
      scope: "full",
      publicKey: grant.publicKey || "",
    });
    savePairState(home, state);
  } else {
    accessToken = randomToken();
    state = addGrant(state, {
      peerId: machineId,
      name: displayName || "Machine",
      token: accessToken,
      tokenSalt: randomSalt(),
      now: Date.now(),
      scope: "full",
    });
    savePairState(home, state);
  }
  const issuedAt = new Date().toISOString();
  const offer = { hostId: machineId, peerId: self.machineId, accessToken, issuedAt };
  const signature = signReciprocal(self.privateKey, offer);
  await offerReciprocalRemote({ url, inboundToken, offer, signature, fetchImpl }).catch(() => {});
}

/**
 * Pair this machine with every other trusted machine it can reach, including
 * phones, and send a reciprocal grant so they can see this machine too.
 */
export async function meshTrustedPeers(home, { fetchImpl = fetch, mount } = {}) {
  try {
    const cloud = await import("./linked-cloud.mjs");
    const vault = await import("./linked-vault.mjs");
    const listed = await cloud.fetchMachines(home);
    if (!listed?.ok || listed.needsUnlock) return { paired: 0 };
    const self = loadIdentity(home);
    const dek = vault.loadDek(home);
    if (!dek || !self?.privateKey || !self.machineId) return { paired: 0 };
    const records = loadLinkedTokens(home);
    const attestation = await sponsorAttestation(home, records, self.machineId, fetchImpl);
    const now = Date.now();
    let paired = 0;
    for (const machine of listed.machines || []) {
      if (!machine?.machineId || machine.machineId === listed.selfId || machine.machineId === self.machineId) continue;
      if (hasFullToken(records, machine.machineId)) {
        continue;
      }
      const candidates = connectionCandidates(machine);
      if (!candidates.length) continue;
      if (!isOnline(machine.lastSeen, now) && !candidates.some((row) => row.via === "lan")) {
        // Still try once: lastSeen can lag while LAN or Tailscale is up.
      }
      for (const target of candidates) {
        if (target.risk) continue;
        const secret = randomToken();
        const parts = { hostId: machine.machineId, peerId: self.machineId, secret };
        const asked = await requestRemote({
          url: target.url,
          machineId: self.machineId,
          displayName: self.displayName || "Drivebay",
          secret,
          proof: joinProof(dek, parts),
          signature: signJoin(self.privateKey, parts),
          attestation,
          fetchImpl,
        }).catch(() => null);
        if (!asked?.ok) continue;
        let polled = await pollRemote({ url: target.url, id: asked.id, secret, fetchImpl }).catch(() => null);
        if (!polled?.ok && asked.granted) {
          polled = await pollRemote({ url: target.url, id: asked.id, secret, fetchImpl }).catch(() => null);
        }
        if (!polled?.ok || polled.scope !== "full") {
          if (asked.ok) {
            records[machine.machineId] = {
              ...(records[machine.machineId] || {}),
              pendingId: asked.id,
              pendingSecret: secret,
              url: target.url,
              pendingAt: Date.now(),
            };
            saveLinkedTokens(home, records);
          }
          continue;
        }
        if (typeof mount === "function") {
          const letter = pickDriveLetter(loadLinkedTokens(home), machine.machineId, records[machine.machineId]?.letter || "P");
          await mount(home, machine.machineId, polled.token, machine, letter, polled.scope);
        } else {
          const current = loadLinkedTokens(home);
          current[machine.machineId] = {
            ...(current[machine.machineId] || {}),
            token: polled.token,
            url: target.url,
            label: machine.displayName || "",
            scope: "full",
            via: target.via,
          };
          saveLinkedTokens(home, current);
        }
        await offerReciprocal(home, machine.machineId, target.url, polled.token, machine.displayName || "", fetchImpl);
        paired += 1;
        break;
      }
    }
    return { paired };
  } catch {
    return { paired: 0 };
  }
}
