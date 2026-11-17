import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";

async function homeDir() {
  const store = await import("./linked-store.mjs");
  const fromEnv = store.machineHome();
  if (fromEnv) return fromEnv;
  const settings = await import("./settings.server");
  return settings.resolveDataDir();
}

async function adminHome() {
  const host = await import("./host-request.server");
  host.assertPcAdmin();
  return homeDir();
}

export const getLinkedStatus = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async () => {
    const home = await adminHome();
    const store = await import("./linked-store.mjs");
    const machines = await import("./linked-machines.mjs");
    const identity = store.loadIdentity(home);
    const vault = await import("./linked-vault.mjs");
    const cloud = await import("./linked-cloud.mjs");
    const listed = store.loadAccount(home)?.uid
      ? await cloud.fetchVault(home).catch((err: Error) => ({ ok: false as const, wraps: [], locked: false, error: err?.message || "Could not reach the lock records." }))
      : null;
    const localPairs = machines.publicPairState(store.loadPairState(home));
    const sponsor = await import("./linked-sponsor.mjs");
    const remotePending = await sponsor.listRemotePending(home).catch(() => []);
    const hostId = identity?.machineId || "";
    const pending = [
      ...localPairs.pending.map((row: { id: string; fromId?: string; name?: string; at?: number; join?: boolean }) => ({
        ...row,
        hostId,
        hostName: "this machine",
      })),
      ...remotePending,
    ];
    return {
      account: store.publicAccount(store.loadAccount(home)),
      config: store.publicFirebaseConfig(store.loadFirebaseConfig(home)),
      shares: store.loadShares(home),
      pairs: { ...localPairs, pending },
      links: store.publicLinks(store.loadLinkedTokens(home)),
      self: identity?.machineId
        ? { machineId: identity.machineId, displayName: identity.displayName || "", publicKey: identity.publicKey || "" }
        : null,
      warning: machines.DIRECT_INTERNET_WARNING,
      vault: vault.accountVaultStatus(home, listed),
      remoteAccess: (await import("./settings.server")).readRemoteAccess(),
    };
  });

export const saveMesaSession = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      idToken: z.string().min(20).max(8192),
      refreshToken: z.string().min(10).max(4096),
      expiresIn: z.number().int().positive().max(86400),
    }),
  )
  .handler(async ({ data }) => {
    const home = await adminHome();
    const store = await import("./linked-store.mjs");
    const cloud = await import("./linked-cloud.mjs");
    const config = store.loadFirebaseConfig(home);
    if (!config?.ready) return { ok: false as const, message: "Add mesa-firebase.json on this machine first." };
    const verified = await cloud.verifyFirebaseIdToken(data.idToken, config);
    if (!verified) return { ok: false as const, message: "Mesa and Moon did not accept that sign-in." };
    store.saveAccount(home, {
      ...verified,
      idToken: data.idToken,
      refreshToken: data.refreshToken,
      expiresAt: Date.now() + data.expiresIn * 1000,
    });
    const settings = await import("./settings.server");
    const pushed = await cloud.pushThisMachine(home, settings.readPortSettings().port);
    return { ok: true as const, message: pushed.ok ? "Signed in." : pushed.error || "Signed in." };
  });

export const signOutMesa = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async () => {
    const home = await adminHome();
    const store = await import("./linked-store.mjs");
    store.clearAccount(home);
    return { ok: true as const };
  });

const folderRow = z.object({
  path: z.string().min(1).max(4096),
  access: z.enum(["ro", "rw"]),
  name: z.string().max(80).optional(),
});

export const saveLinkedShares = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      displayName: z.string().max(80).optional(),
      hidden: z.boolean(),
      directInternet: z.boolean(),
      publicHost: z.string().max(253).optional(),
      folders: z.array(folderRow).max(100),
    }),
  )
  .handler(async ({ data }) => {
    const home = await adminHome();
    const store = await import("./linked-store.mjs");
    const machines = await import("./linked-machines.mjs");
    if (data.directInternet && !String(data.publicHost || "").trim()) {
      return { ok: false as const, message: machines.DIRECT_INTERNET_WARNING };
    }
    const fs = await import("node:fs");
    const folders = [];
    for (const row of data.folders) {
      let real = "";
      try {
        real = fs.realpathSync(row.path);
      } catch {
        return { ok: false as const, message: `That folder is not on this machine: ${row.path}` };
      }
      if (!fs.statSync(real).isDirectory()) return { ok: false as const, message: "Share a folder, not a file." };
      folders.push({ path: real, access: row.access, name: row.name || "" });
    }
    store.saveShares(home, {
      hidden: data.hidden,
      directInternet: data.directInternet,
      publicHost: data.publicHost || "",
      folders,
    });
    if (data.displayName && data.displayName.trim()) {
      const cloud = await import("./linked-cloud.mjs");
      cloud.ensureIdentity(home, data.displayName.trim());
    }
    const settings = await import("./settings.server");
    const cloud = await import("./linked-cloud.mjs");
    if (store.loadAccount(home)?.uid) await cloud.pushThisMachine(home, settings.readPortSettings().port);
    return { ok: true as const, shares: store.loadShares(home) };
  });

export const listLinkedMachines = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async () => {
    const home = await adminHome();
    const cloud = await import("./linked-cloud.mjs");
    const machines = await import("./linked-machines.mjs");
    const listed = await cloud.fetchMachines(home);
    if (!listed.ok) return { ok: false as const, message: listed.error || "No machine list.", machines: [] as const };
    if (listed.needsUnlock) {
      return {
        ok: false as const,
        message: "Unlock the machine list on this device with your passphrase, passkey, or recovery key.",
        machines: [] as const,
        needsUnlock: true as const,
      };
    }
    const now = Date.now();
    const rows = (listed.machines || []).map((row: { lastSeen?: string; machineId?: string }) => ({
      ...row,
      online: machines.isOnline(row.lastSeen, now),
      self: row.machineId === listed.selfId,
      connect: machines.connectionUrl(row),
    }));
    return { ok: true as const, machines: rows, message: "" };
  });

export const createLinkedCode = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async () => {
    const home = await adminHome();
    const machines = await import("./linked-machines.mjs");
    const http = await import("./linked-http.mjs");
    const code = machines.randomCode();
    return http.issueLocalCode(home, code);
  });

export const approveLinkedRequest = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      id: z.string().min(8).max(200),
      hostId: z.string().min(8).max(64).optional(),
      fromId: z.string().max(64).optional(),
      name: z.string().max(80).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const home = await adminHome();
    const http = await import("./linked-http.mjs");
    const sponsor = await import("./linked-sponsor.mjs");
    const store = await import("./linked-store.mjs");
    const vault = await import("./linked-vault.mjs");
    const self = store.loadIdentity(home);
    const dek = vault.loadDek(home);
    if (data.hostId && self?.machineId && data.hostId !== self.machineId) {
      const remote = await approveOnTrustedHost(home, data);
      return remote.ok ? { ok: true as const } : { ok: false as const, message: remote.error || "Could not approve on that machine." };
    }
    const state = store.loadPairState(home);
    const row = (state.pending || []).find((item: { id?: string }) => item.id === data.id);
    const result = http.approveLocalRequest(home, data.id);
    if (!result.ok) return { ok: false as const, message: result.error || "Could not approve." };
    if (dek && self?.privateKey && self.machineId) {
      const attestation = sponsor.makeAttestation({
        dek,
        privateKey: self.privateKey,
        approverId: self.machineId,
        joinerId: String(row?.fromId || data.fromId || ""),
        joinerName: String(row?.name || data.name || ""),
        joinerPublicKey: String(row?.publicKey || ""),
        requestId: data.id,
        hostId: self.machineId,
      });
      await sponsor.spreadHonoredApproval(home, attestation).catch(() => {});
    }
    return { ok: true as const };
  });

export const denyLinkedRequest = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      id: z.string().min(8).max(200),
      hostId: z.string().min(8).max(64).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const home = await adminHome();
    const http = await import("./linked-http.mjs");
    const store = await import("./linked-store.mjs");
    const self = store.loadIdentity(home);
    if (data.hostId && self?.machineId && data.hostId !== self.machineId) {
      const remote = await denyOnTrustedHost(home, data);
      return remote.ok ? { ok: true as const } : { ok: false as const, message: remote.error || "Could not deny on that machine." };
    }
    const result = http.denyLocalRequest(home, data.id);
    return result.ok ? { ok: true as const } : { ok: false as const, message: result.error || "Could not deny." };
  });

export const revokeLinkedGrant = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ id: z.string().min(1).max(200) }))
  .handler(async ({ data }) => {
    const home = await adminHome();
    await notifyForgetPeer(home, data.id);
    const http = await import("./linked-http.mjs");
    const result = http.revokeLocalGrant(home, data.id);
    return result.ok ? { ok: true as const } : { ok: false as const, message: result.error || "Could not remove that device." };
  });

async function mountSaved(home: string, machineId: string, token: string, machine: Record<string, unknown>, letter: string, scope: "full" | "shares" = "shares") {
  const machines = await import("./linked-machines.mjs");
  const drive = await import("./phone-drive.mjs");
  const store = await import("./linked-store.mjs");
  const records = store.loadLinkedTokens(home);
  const taken = Object.entries(records)
    .filter(([id]) => id !== machineId)
    .map(([, row]) => (row as { label?: string })?.label || "")
    .filter(Boolean);
  const plan = machines.linkedMountPlan({ machine, secret: token, letter, home, takenLabels: taken });
  if (!plan.ok) return { ok: false as const, message: plan.error || "Cannot mount" };
  const result = await drive.runMount(plan);
  records[machineId] = {
    token,
    url: plan.url,
    label: plan.volumeLabel,
    letter: plan.letter || letter,
    method: plan.method,
    mountPoint: plan.mountPoint || "",
    via: plan.via,
    scope,
  };
  store.saveLinkedTokens(home, records);
  if (result.code === 0 && plan.volumeLabel) {
    await drive.setDriveLabel(plan.url, plan.volumeLabel, process.platform, plan.risk === true);
  }
  const shown = plan.userFacing || plan.volumeLabel || "that machine";
  return {
    ok: result.code === 0,
    message: result.code === 0
      ? scope === "full" ? `Mounted ${shown}. You can browse all of its drives.` : `Mounted ${shown}. Only its shared folders are visible.`
      : drive.redact(result.output, token),
    display: shown,
    scope,
  };
}

export const connectLinkedMachine = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      machineId: z.string().min(8).max(64),
      code: z.string().max(200).optional(),
      letter: z.string().max(8).optional(),
      askApproval: z.boolean().optional(),
      acceptRisk: z.boolean().optional(),
      join: z.boolean().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const home = await adminHome();
    const cloud = await import("./linked-cloud.mjs");
    const machines = await import("./linked-machines.mjs");
    const store = await import("./linked-store.mjs");
    const connect = await import("./linked-connect.mjs");
    const listed = await cloud.fetchMachines(home);
    if (!listed.ok) return { ok: false as const, message: listed.error || "No machine list." };
    const machine = (listed.machines || []).find((row: { machineId?: string }) => row.machineId === data.machineId);
    if (!machine) return { ok: false as const, message: "That machine is not on this login." };
    if (machine.machineId === listed.selfId) return { ok: false as const, message: "This is the machine you are using." };
    const target = machines.connectionUrl(machine);
    if (!target.url) return { ok: false as const, message: "That machine has no Tailscale or LAN address." };
    if (target.risk && !data.acceptRisk) {
      return { ok: false as const, message: machines.DIRECT_INTERNET_WARNING, needsRisk: true as const };
    }
    const self = store.loadIdentity(home);
    if (machine.type !== "phone") {
      const confirmed = await connect.confirmDesktop(target.url, machine.publicKey);
      if (!confirmed.ok) return { ok: false as const, message: confirmed.error };
    }
    const saved = store.loadLinkedTokens(home)[data.machineId];
    const letter = machines.pickDriveLetter(store.loadLinkedTokens(home), data.machineId, data.letter || saved?.letter || "P");
    let token = saved?.token ? String(saved.token) : "";
    if (data.code && String(data.code).trim()) {
      if (machine.type === "phone") token = String(data.code).trim();
      else {
        const redeemed = await connect.redeemRemote({
          url: target.url,
          code: String(data.code).trim(),
          machineId: self?.machineId || "peer",
          displayName: self?.displayName || "Drivebay",
        });
        if (!redeemed.ok) return { ok: false as const, message: redeemed.error };
        token = redeemed.token;
      }
    }
    if (!token && (data.askApproval || data.join) && machine.type === "phone" && data.join) {
      return { ok: false as const, message: "Join this phone from the phone: open Machines on it and pick this computer." };
    }
    if (!token && (data.askApproval || data.join) && machine.type !== "phone") {
      const secret = machines.randomToken();
      let proof = "";
      let signature = "";
      if (data.join) {
        // Joining needs the join password: the machine list must be unlocked on this device,
        // which is the only way to hold the account key. Send a proof of it, never the key.
        const vault = await import("./linked-vault.mjs");
        const crypto = await import("./linked-crypto.mjs");
        const dek = vault.loadDek(home);
        if (!dek || !self?.privateKey || !self.machineId) {
          return {
            ok: false as const,
            needsPassword: true as const,
            message: "Enter your join password first. Unlock the machine list on this device in My machines, then join.",
          };
        }
        const parts = { hostId: machine.machineId, peerId: self.machineId, secret };
        proof = crypto.joinProof(dek, parts);
        signature = crypto.signJoin(self.privateKey, parts);
      }
      const asked = await connect.requestRemote({
        url: target.url,
        machineId: self?.machineId || "peer",
        displayName: self?.displayName || "Drivebay",
        secret,
        proof,
        signature,
      });
      if (!asked.ok) return { ok: false as const, message: asked.error };
      const records = store.loadLinkedTokens(home);
      records[data.machineId] = { ...(records[data.machineId] || {}), pendingId: asked.id, pendingSecret: secret, url: target.url, letter };
      store.saveLinkedTokens(home, records);
      return {
        ok: true as const,
        pending: true as const,
        message: data.join
          ? `Waiting for a trusted device to approve this join on ${machine.displayName || "that machine"}.`
          : "Waiting for approval on that machine.",
      };
    }
    if (!token) return { ok: false as const, message: "Join this machine with your join password. The 6-digit code is only for someone else opening shared folders." };
    return mountSaved(home, data.machineId, token, machine, letter, (saved?.token && !data.code ? saved.scope : "shares") === "full" ? "full" : "shares");
  });

export const finishLinkedMachine = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ machineId: z.string().min(8).max(64), letter: z.string().max(8).optional() }))
  .handler(async ({ data }) => {
    const home = await adminHome();
    const store = await import("./linked-store.mjs");
    const cloud = await import("./linked-cloud.mjs");
    const connect = await import("./linked-connect.mjs");
    const machines = await import("./linked-machines.mjs");
    const row = store.loadLinkedTokens(home)[data.machineId];
    if (!row?.pendingId || !row.pendingSecret || !row.url) {
      return { ok: false as const, message: "This machine is not waiting for approval." };
    }
    const polled = await connect.pollRemote({ url: row.url, id: row.pendingId, secret: row.pendingSecret });
    if (!polled.ok) return { ok: false as const, pending: true as const, message: polled.error };
    const listed = await cloud.fetchMachines(home);
    const machine = (listed.machines || []).find((item: { machineId?: string }) => item.machineId === data.machineId);
    if (!machine) return { ok: false as const, message: "That machine is not on this login." };
    const letter = machines.pickDriveLetter(store.loadLinkedTokens(home), data.machineId, data.letter || row.letter || "P");
    return mountSaved(home, data.machineId, polled.token, machine, letter, polled.scope === "full" ? "full" : "shares");
  });

export const disconnectLinkedMachine = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ machineId: z.string().min(8).max(64), forget: z.boolean().optional() }))
  .handler(async ({ data }) => {
    const home = await adminHome();
    const store = await import("./linked-store.mjs");
    const machines = await import("./linked-machines.mjs");
    const drive = await import("./phone-drive.mjs");
    const records = store.loadLinkedTokens(home);
    const row = records[data.machineId];
    if (!row?.url) return { ok: false as const, message: "That machine is not saved on this PC." };
    const plan = machines.linkedUnmountPlan(row, { platform: process.platform, home });
    if (!plan.ok) return { ok: false as const, message: plan.error || "Cannot unmount" };
    const result = await drive.runMount(plan);
    if (result.code === 0 && row.url) await drive.clearDriveLabel(row.url);
    if (data.forget) {
      await notifyForgetPeer(home, data.machineId);
      const http = await import("./linked-http.mjs");
      http.revokeLocalGrant(home, data.machineId);
      delete records[data.machineId];
      store.saveLinkedTokens(home, records);
    }
    return { ok: result.code === 0, message: drive.redact(result.output, row.token || "") };
  });


export const setupLinkedVault = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      passphrase: z.string().min(8).max(256),
      prfOutput: z.string().min(16).max(256).optional(),
      credentialId: z.string().max(512).optional(),
      prfSalt: z.string().max(256).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const home = await adminHome();
    const vault = await import("./linked-vault.mjs");
    const cloud = await import("./linked-cloud.mjs");
    const settings = await import("./settings.server");
    const existing = await cloud.fetchVault(home);
    if (vault.accountAlreadyLocked(existing)) {
      return {
        ok: false as const,
        message: "This account already has a join password. Enter it instead of setting a new one.",
      };
    }
    if (existing.ok === false) {
      return {
        ok: false as const,
        message: existing.error || "Could not check whether this account already has a join password. Try again before setting a new one.",
      };
    }
    const setup = vault.setupVault(home, {
      passphrase: data.passphrase,
      prfOutput: data.prfOutput,
      credentialId: data.credentialId,
      prfSalt: data.prfSalt,
    });
    if (!setup.ok) return { ok: false as const, message: setup.error || "Could not lock the machine list." };
    const wraps = await cloud.pushVaultWraps(home, setup.wraps);
    if (!wraps.ok) return { ok: false as const, message: wraps.error || "The cloud did not accept the lock records." };
    const listed = await cloud.fetchMachines(home);
    if (listed.migrated) {
      /* legacy rows were rewritten as ciphertext */
    }
    await cloud.pushThisMachine(home, settings.readPortSettings().port);
    return {
      ok: true as const,
      recoveryKey: setup.recoveryKey as string,
      message: setup.message as string,
    };
  });

export const unlockLinkedVault = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      passphrase: z.string().max(256).optional(),
      recoveryKey: z.string().max(256).optional(),
      prfOutput: z.string().min(16).max(256).optional(),
      wrapId: z.string().min(8).max(64).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const home = await adminHome();
    const vault = await import("./linked-vault.mjs");
    const cloud = await import("./linked-cloud.mjs");
    const listed = await cloud.fetchVault(home);
    const wraps = listed.wraps || [];
    const wrap = data.prfOutput
      ? wraps.find((row: { kind?: string; wrapId?: string }) => row.kind === "passkey" && (!data.wrapId || row.wrapId === data.wrapId))
      : data.recoveryKey
        ? wraps.find((row: { kind?: string }) => row.kind === "recovery")
        : wraps.find((row: { kind?: string }) => row.kind === "passphrase");
    const unlocked = vault.unlockWithSecret(home, { ...data, wrap });
    if (!unlocked.ok) return { ok: false as const, message: unlocked.error || "Could not unlock the machine list." };
    const settings = await import("./settings.server");
    await cloud.pushThisMachine(home, settings.readPortSettings().port);
    const joins = await requestJoinOnTrustedPeers(home);
    const message = joins.asked
      ? `The machine list is unlocked. Waiting for a trusted device on ${joins.names[0]} to approve this computer.`
      : "The machine list is unlocked on this device. Open My machines and click Join on a trusted computer, then approve it there.";
    return { ok: true as const, pending: joins.asked > 0, message };
  });

export const setMachineRemoteAccess = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      machineId: z.string().min(8).max(64),
      enabled: z.boolean(),
      minutes: z.number().int().optional(),
      mode: z.enum(["ro", "rw"]).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const home = await adminHome();
    const store = await import("./linked-store.mjs");
    if (!store.loadAccount(home)?.uid) return { ok: false as const, message: "Sign in to Mesa and Moon first." };
    const settings = await import("./settings.server");
    const identity = store.loadIdentity(home);
    if (data.machineId === identity?.machineId || data.machineId === "self") {
      const next = settings.writeRemoteAccess({
        enabled: data.enabled,
        minutes: data.minutes || 15,
        mode: data.mode || "rw",
        source: "local",
        byName: identity?.displayName || "this computer",
        byMachineId: identity?.machineId || "",
      });
      return { ok: true as const, ...next, message: next.enabled ? "Remote access is on." : "Remote access is off." };
    }
    const cloud = await import("./linked-cloud.mjs");
    const machines = await import("./linked-machines.mjs");
    const listed = await cloud.fetchMachines(home);
    if (!listed.ok) return { ok: false as const, message: listed.error || "No machine list." };
    const machine = (listed.machines || []).find((row: { machineId?: string }) => row.machineId === data.machineId);
    if (!machine) return { ok: false as const, message: "That machine is not on this login." };
    const target = machines.connectionUrl(machine);
    if (target.via !== "tailscale" || !target.url) {
      return { ok: false as const, message: "Turn remote access on from a device that is already on the Tailscale network." };
    }
    const token = store.loadLinkedTokens(home)[data.machineId]?.token;
    if (!token) return { ok: false as const, message: "Pair this device with that computer first." };
    const origin = new URL(target.url).origin;
    const res = await fetch(`${origin}/api/link/remote-access`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        enabled: data.enabled,
        minutes: data.minutes || 15,
        mode: data.mode || "rw",
        machineId: identity?.machineId || "",
        displayName: identity?.displayName || "Drivebay",
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false as const, message: body.error || "That machine did not accept the change." };
    return { ok: true as const, ...body, message: body.enabled ? "Remote access is on." : "Remote access is off." };
  });


/** After a new machine unlocks with the account join password, ask a trusted computer to approve it. */
async function approveOnTrustedHost(home: string, data: { id: string; hostId?: string; fromId?: string; name?: string }) {
  const store = await import("./linked-store.mjs");
  const vault = await import("./linked-vault.mjs");
  const sponsor = await import("./linked-sponsor.mjs");
  const records = store.loadLinkedTokens(home);
  const row = data.hostId ? records[data.hostId] : null;
  if (!row?.token || row.scope !== "full" || !row.url) {
    return { ok: false, error: "This device does not have a trusted connection to that machine." };
  }
  const dek = vault.loadDek(home);
  const self = store.loadIdentity(home);
  if (!dek || !self?.privateKey || !self.machineId) {
    return { ok: false, error: "Unlock the machine list on this device first." };
  }
  let origin = "";
  try { origin = new URL(row.url).origin; } catch { return { ok: false, error: "That machine address is not valid." }; }
  const attestation = sponsor.makeAttestation({
    dek,
    privateKey: self.privateKey,
    approverId: self.machineId,
    joinerId: String(data.fromId || ""),
    joinerName: String(data.name || ""),
    requestId: data.id,
    hostId: data.hostId || "",
  });
  const res = await fetch(`${origin}/api/link/approve`, {
    method: "POST",
    headers: { authorization: `Bearer ${row.token}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ id: data.id, attestation }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: body.error || "That machine did not accept the approval." };
  if (data.fromId) sponsor.issueLocalSponsoredGrant(home, { joinerId: data.fromId, joinerName: data.name || "" });
  await sponsor.spreadHonoredApproval(home, attestation).catch(() => {});
  return { ok: true };
}

async function denyOnTrustedHost(home: string, data: { id: string; hostId?: string }) {
  const store = await import("./linked-store.mjs");
  const records = store.loadLinkedTokens(home);
  const row = data.hostId ? records[data.hostId] : null;
  if (!row?.token || row.scope !== "full" || !row.url) {
    return { ok: false, error: "This device does not have a trusted connection to that machine." };
  }
  let origin = "";
  try { origin = new URL(row.url).origin; } catch { return { ok: false, error: "That machine address is not valid." }; }
  const res = await fetch(`${origin}/api/link/deny`, {
    method: "POST",
    headers: { authorization: `Bearer ${row.token}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ id: data.id }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: body.error || "That machine did not accept the denial." };
  return { ok: true };
}

async function requestJoinOnTrustedPeers(home: string): Promise<{ asked: number; names: string[] }> {
  try {
    const cloud = await import("./linked-cloud.mjs");
    const machines = await import("./linked-machines.mjs");
    const store = await import("./linked-store.mjs");
    const connect = await import("./linked-connect.mjs");
    const vault = await import("./linked-vault.mjs");
    const crypto = await import("./linked-crypto.mjs");
    const listed = await cloud.fetchMachines(home);
    if (!listed.ok || listed.needsUnlock) return { asked: 0, names: [] };
    const self = store.loadIdentity(home);
    const dek = vault.loadDek(home);
    if (!dek || !self?.privateKey || !self.machineId) return { asked: 0, names: [] };
    const now = Date.now();
    const names: string[] = [];
    for (const machine of listed.machines || []) {
      if (!machine?.machineId || machine.machineId === listed.selfId) continue;
      if (machine.type === "phone") continue;
      if (!machines.isOnline(machine.lastSeen, now)) continue;
      const target = machines.connectionUrl(machine);
      if (!target.url || target.risk) continue;
      const secret = machines.randomToken();
      const parts = { hostId: machine.machineId, peerId: self.machineId, secret };
      const asked = await connect.requestRemote({
        url: target.url,
        machineId: self.machineId,
        displayName: self.displayName || "Drivebay",
        secret,
        proof: crypto.joinProof(dek, parts),
        signature: crypto.signJoin(self.privateKey, parts),
      });
      if (!asked.ok) continue;
      const records = store.loadLinkedTokens(home);
      records[machine.machineId] = {
        ...(records[machine.machineId] || {}),
        pendingId: asked.id,
        pendingSecret: secret,
        url: target.url,
      };
      store.saveLinkedTokens(home, records);
      names.push(machine.displayName || "that machine");
    }
    return { asked: names.length, names };
  } catch {
    return { asked: 0, names: [] };
  }
}

async function notifyForgetPeer(home: string, peerId: string) {
  try {
    const store = await import("./linked-store.mjs");
    const cloud = await import("./linked-cloud.mjs");
    const machines = await import("./linked-machines.mjs");
    const browse = await import("./linked-browse.mjs");
    const reciprocal = await import("./linked-reciprocal.mjs");
    const identity = store.loadIdentity(home);
    const saved = store.loadLinkedTokens(home)[peerId];
    const listed = await cloud.fetchMachines(home).catch(() => null);
    const machine = (listed?.machines || []).find((row: { machineId?: string }) => row.machineId === peerId);
    const target = machine ? machines.connectionUrl(machine) : { url: saved?.url || "" };
    const issuedAt = new Date().toISOString();
    let signature = "";
    if (identity?.privateKey && identity.machineId) {
      signature = reciprocal.signForget(identity.privateKey, {
        fromId: identity.machineId,
        peerId,
        issuedAt,
      });
    }
    await browse.notifyPeerForget({
      url: target.url || saved?.url || "",
      token: saved?.token || "",
      fromId: identity?.machineId || "",
      peerId,
      signature,
      issuedAt,
    });
  } catch {
    // A local forget must still succeed if the other machine is offline.
  }
}

async function resolveLinkedTarget(home: string, machineId: string) {
  const store = await import("./linked-store.mjs");
  const cloud = await import("./linked-cloud.mjs");
  const machines = await import("./linked-machines.mjs");
  const saved = store.loadLinkedTokens(home)[machineId];
  if (!saved?.token) return { ok: false as const, message: "This computer does not have access to that machine yet." };
  const listed = await cloud.fetchMachines(home);
  if (!listed.ok) return { ok: false as const, message: listed.error || "No machine list." };
  const machine = (listed.machines || []).find((row: { machineId?: string }) => row.machineId === machineId);
  if (!machine) return { ok: false as const, message: "That machine is not on this login." };
  return { ok: true as const, machine, token: String(saved.token) };
}

export const listLinkedBrowse = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ machineId: z.string().min(8).max(64), path: z.string().max(4000).optional() }))
  .handler(async ({ data }) => {
    const home = await adminHome();
    const target = await resolveLinkedTarget(home, data.machineId);
    if (!target.ok) return { ok: false as const, message: target.message, entries: [] as const, path: data.path || "/" };
    const browse = await import("./linked-browse.mjs");
    const listed = await browse.listRemote({ machine: target.machine, token: target.token, path: data.path || "/" });
    return listed.ok
      ? { ok: true as const, entries: listed.entries, path: listed.path, message: "" }
      : { ok: false as const, message: listed.error || "Could not browse.", entries: [] as const, path: data.path || "/" };
  });

export const mutateLinkedBrowse = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      machineId: z.string().min(8).max(64),
      method: z.enum(["DELETE", "MKCOL", "MOVE", "PUT"]),
      path: z.string().min(1).max(4000),
      destination: z.string().max(4000).optional(),
      content: z.string().max(20_000_000).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const home = await adminHome();
    const target = await resolveLinkedTarget(home, data.machineId);
    if (!target.ok) return { ok: false as const, message: target.message };
    const browse = await import("./linked-browse.mjs");
    const body = data.method === "PUT" && data.content ? Buffer.from(data.content, "base64") : undefined;
    const result = await browse.mutateRemote({
      machine: target.machine,
      token: target.token,
      method: data.method,
      path: data.path,
      destination: data.destination,
      body,
    });
    return result.ok ? { ok: true as const, message: "" } : { ok: false as const, message: result.error || "Could not change that file." };
  });

export const readLinkedBrowse = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ machineId: z.string().min(8).max(64), path: z.string().min(1).max(4000) }))
  .handler(async ({ data }) => {
    const home = await adminHome();
    const target = await resolveLinkedTarget(home, data.machineId);
    if (!target.ok) return { ok: false as const, message: target.message };
    const browse = await import("./linked-browse.mjs");
    const result = await browse.readRemote({ machine: target.machine, token: target.token, path: data.path });
    if (!result.ok) return { ok: false as const, message: result.error || "Could not read that file." };
    if (result.bytes.length > 15_000_000) return { ok: false as const, message: "That file is too large to open here." };
    return { ok: true as const, content: result.bytes.toString("base64"), name: result.name, type: result.type };
  });
