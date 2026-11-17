import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { UPGRADE_URL } from "./public-keys.mjs";

async function view(home: string, ctx: { machineId: string; buildTs: number }) {
  const store = await import("./license-store.mjs");
  const record = store.loadLicenseRecord(home) || store.loadDropInLicense(home);
  const state = store.evaluateLicense(record, { machineId: ctx.machineId, buildTs: ctx.buildTs });
  return { ...store.publicLicenseView(state, record), upgradeUrl: UPGRADE_URL, fromFile: Boolean(record && "fromFile" in record && record.fromFile) };
}

export const getEditionStatus = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async () => {
    const host = await import("@/lib/files/host-request.server");
    host.assertPcAdmin();
    const { home, ctx } = await (await import("./license.server")).licenseContext();
    const first = await view(home, ctx);
    if (first.needsRefresh) {
      // Renew quietly when due. A network failure keeps what the page already shows.
      const store = await import("./license-store.mjs");
      await store.refreshLicense(home, ctx).catch(() => null);
      return view(home, ctx);
    }
    return first;
  });

export const activateEdition = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ code: z.string().min(8).max(4096) }))
  .handler(async ({ data }) => {
    const host = await import("@/lib/files/host-request.server");
    host.assertPcAdmin();
    const { home, ctx } = await (await import("./license.server")).licenseContext();
    const store = await import("./license-store.mjs");
    const result = await store.activateLicense(home, data.code, ctx);
    return { result, status: await view(home, ctx) };
  });

export const refreshEdition = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async () => {
    const host = await import("@/lib/files/host-request.server");
    host.assertPcAdmin();
    const { home, ctx } = await (await import("./license.server")).licenseContext();
    const store = await import("./license-store.mjs");
    const result = await store.refreshLicense(home, ctx);
    return { result, status: await view(home, ctx) };
  });

export const deactivateEdition = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ force: z.boolean().optional() }))
  .handler(async ({ data }) => {
    const host = await import("@/lib/files/host-request.server");
    host.assertPcAdmin();
    const { home, ctx } = await (await import("./license.server")).licenseContext();
    const store = await import("./license-store.mjs");
    const result = await store.deactivateLicense(home, { ...ctx, force: data.force === true });
    return { result, status: await view(home, ctx) };
  });
