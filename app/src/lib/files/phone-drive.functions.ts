import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";

export const mountPhoneDrive = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      url: z.string().min(1).max(300),
      secret: z.string().trim().min(6).max(200),
      letter: z.string().max(8).optional(),
      label: z.string().max(80).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const host = await import("./host-request.server");
    host.assertPcAdmin();
    const drive = await import("./phone-drive.mjs");
    const home = process.env.DRIVEBAY_HOME;
    const existing = home ? drive.loadPhoneTokens(home) : {};
    const key = drive.phoneKey(data.url) || "";
    const taken = Object.entries(existing)
      .filter(([id]) => id !== key)
      .map(([, row]) => row?.label)
      .filter(Boolean);
    let raw = drive.pcName(data.label || "");
    if (!raw) {
      await drive.announcePc(data.url, data.secret, drive.pcName());
      raw = drive.announcedPhoneName();
    }
    const label = drive.volumeLabel(raw || "Phone", { taken, id: key });
    const plan = drive.mountPlan({
      platform: process.platform,
      url: data.url,
      secret: data.secret,
      letter: data.letter || "Z",
      user: "drivebay",
      volumeName: label,
    });
    if (!plan.ok) return { ok: false as const, message: plan.error || "Cannot mount", display: "" };
    const result = await drive.runMount(plan);
    if (result.code === 0) {
      await drive.announcePc(data.url, data.secret, drive.pcName());
      const shown = drive.volumeLabel(drive.pcName(data.label || "") || drive.announcedPhoneName() || label, { taken, id: key });
      await drive.setDriveLabel(data.url, shown);
      if (home) {
        const records = drive.rememberPhoneToken(drive.loadPhoneTokens(home), {
          url: data.url,
          secret: data.secret,
          label: shown,
          method: plan.method,
          letter: plan.letter || data.letter || "Z",
          mountPoint: plan.mountPoint || "",
          now: Date.now(),
        });
        drive.savePhoneTokens(home, records);
      }
      return { ok: true as const, message: `Mounted ${shown}.`, display: shown };
    }
    return {
      ok: false as const,
      message: drive.redact(result.output, data.secret),
      display: label,
    };
  });

export const listPhoneDrives = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async () => {
    const host = await import("./host-request.server");
    host.assertPcAdmin();
    const drive = await import("./phone-drive.mjs");
    return { phones: drive.publicPhones(drive.loadPhoneTokens(process.env.DRIVEBAY_HOME)) };
  });

export const remountPhoneDrive = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ key: z.string().min(1).max(200), letter: z.string().max(8).optional() }))
  .handler(async ({ data }) => {
    const host = await import("./host-request.server");
    host.assertPcAdmin();
    const drive = await import("./phone-drive.mjs");
    const records = drive.loadPhoneTokens(process.env.DRIVEBAY_HOME);
    const row = records[data.key];
    if (!row?.secret || !row.url) return { ok: false as const, message: "That phone is not saved on this PC.", display: "" };
    const taken = Object.entries(records)
      .filter(([id]) => id !== data.key)
      .map(([, item]) => item?.label)
      .filter(Boolean);
    let raw = drive.pcName(row.label || "");
    if (!raw) {
      await drive.announcePc(row.url, row.secret, drive.pcName());
      raw = drive.announcedPhoneName();
    }
    const label = drive.volumeLabel(raw || "Phone", { taken, id: data.key });
    const plan = drive.mountPlan({
      platform: process.platform,
      url: row.url,
      secret: row.secret,
      letter: data.letter || row.letter || "Z",
      user: "drivebay",
      volumeName: label,
    });
    if (!plan.ok) return { ok: false as const, message: plan.error || "Cannot mount", display: "" };
    const result = await drive.runMount(plan);
    if (result.code === 0) {
      await drive.announcePc(row.url, row.secret, drive.pcName());
      await drive.setDriveLabel(row.url, label);
    }
    const recordsNext = drive.rememberPhoneToken(records, {
      url: row.url,
      secret: row.secret,
      peer: row.peer,
      label: row.label || label,
      method: plan.method,
      letter: plan.letter || data.letter || row.letter || "Z",
      mountPoint: plan.mountPoint || row.mountPoint || "",
      now: Date.now(),
    });
    if (result.code === 0 && process.env.DRIVEBAY_HOME) drive.savePhoneTokens(process.env.DRIVEBAY_HOME, recordsNext);
    return {
      ok: result.code === 0,
      message: result.code === 0 ? `Mounted ${label}.` : drive.redact(result.output, row.secret),
      display: label,
    };
  });

export const unmountPhoneDrive = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ key: z.string().min(1).max(200) }))
  .handler(async ({ data }) => {
    const host = await import("./host-request.server");
    host.assertPcAdmin();
    const drive = await import("./phone-drive.mjs");
    const records = drive.loadPhoneTokens(process.env.DRIVEBAY_HOME);
    const row = records[data.key];
    if (!row?.url) return { ok: false as const, message: "That phone is not saved on this PC.", display: "" };
    const plan = drive.unmountPlan({
      platform: process.platform,
      method: row.method,
      url: row.url,
      letter: row.letter || "Z",
      mountPoint: row.mountPoint,
      user: "drivebay",
    });
    if (!plan.ok) return { ok: false as const, message: plan.error || "Cannot unmount", display: "" };
    const result = await drive.runMount(plan);
    if (result.code === 0) await drive.clearDriveLabel(row.url);
    return {
      ok: result.code === 0,
      message: drive.redact(result.output, row.secret || ""),
      display: plan.display,
    };
  });

export const forgetPhoneDrive = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ key: z.string().min(1).max(200) }))
  .handler(async ({ data }) => {
    const host = await import("./host-request.server");
    host.assertPcAdmin();
    const drive = await import("./phone-drive.mjs");
    const home = process.env.DRIVEBAY_HOME;
    const saved = drive.loadPhoneTokens(home);
    if (saved[data.key]?.url) await drive.clearDriveLabel(saved[data.key].url);
    if (home) drive.savePhoneTokens(home, drive.forgetPhone(saved, data.key));
    return { ok: true as const };
  });
