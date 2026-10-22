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
    return {
      account: store.publicAccount(store.loadAccount(home)),
      config: store.publicFirebaseConfig(store.loadFirebaseConfig(home)),
      shares: store.loadShares(home),
      pairs: machines.publicPairState(store.loadPairState(home)),
      links: store.publicLinks(store.loadLinkedTokens(home)),
      self: identity?.machineId
        ? { machineId: identity.machineId, displayName: identity.displayName || "", publicKey: identity.publicKey || "" }
        : null,
      warning: machines.DIRECT_INTERNET_WARNING,
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
  .validator(z.object({ id: z.string().min(8).max(200) }))
  .handler(async ({ data }) => {
    const home = await adminHome();
    const http = await import("./linked-http.mjs");
    const result = http.approveLocalRequest(home, data.id);
    return result.ok ? { ok: true as const } : { ok: false as const, message: result.error || "Could not approve." };
  });

async function mountSaved(home: string, machineId: string, token: string, machine: Record<string, unknown>, letter: string) {
  const machines = await import("./linked-machines.mjs");
  const drive = await import("./phone-drive.mjs");
  const store = await import("./linked-store.mjs");
  const plan = machines.linkedMountPlan({ machine, secret: token, letter, home });
  if (!plan.ok) return { ok: false as const, message: plan.error || "Cannot mount" };
  const result = await drive.runMount(plan);
  const records = store.loadLinkedTokens(home);
  records[machineId] = {
    token,
    url: plan.url,
    label: plan.volumeLabel,
    letter: plan.letter || letter,
    method: plan.method,
    mountPoint: plan.mountPoint || "",
    via: plan.via,
  };
  store.saveLinkedTokens(home, records);
  if (result.code === 0 && plan.volumeLabel) {
    await drive.setDriveLabel(plan.url, plan.volumeLabel, process.platform, plan.risk === true);
  }
  return {
    ok: result.code === 0,
    message: drive.redact(result.output, token),
    display: plan.display,
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
    if (!token && data.askApproval && machine.type !== "phone") {
      const secret = machines.randomToken();
      const asked = await connect.requestRemote({
        url: target.url,
        machineId: self?.machineId || "peer",
        displayName: self?.displayName || "Drivebay",
        secret,
      });
      if (!asked.ok) return { ok: false as const, message: asked.error };
      const records = store.loadLinkedTokens(home);
      records[data.machineId] = { ...(records[data.machineId] || {}), pendingId: asked.id, pendingSecret: secret, url: target.url, letter };
      store.saveLinkedTokens(home, records);
      return { ok: true as const, pending: true as const, message: "Waiting for approval on that machine." };
    }
    if (!token) return { ok: false as const, message: "Enter the 6-digit code from that machine, or ask it to approve." };
    return mountSaved(home, data.machineId, token, machine, letter);
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
    return mountSaved(home, data.machineId, polled.token, machine, letter);
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
      delete records[data.machineId];
      store.saveLinkedTokens(home, records);
    }
    return { ok: result.code === 0, message: drive.redact(result.output, row.token || "") };
  });
