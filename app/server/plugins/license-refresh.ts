import { definePlugin } from "nitro";
import { machineHome } from "../../src/lib/files/linked-store.mjs";
import { resolveDataDir } from "../../src/lib/files/settings.server";

/**
 * Renews this machine's license receipt when it is due (about weekly). Quiet and best effort:
 * if the license server is unreachable the current state stays until the receipt runs out.
 * Does nothing when no license is stored.
 */
export default definePlugin(() => {
  const tick = async () => {
    try {
      const home = machineHome() || resolveDataDir();
      const store = await import("../../src/lib/license/license-store.mjs");
      const record = store.loadLicenseRecord(home);
      if (!record) return;
      const { buildTimestamp } = await import("../../src/lib/license/build-info.mjs");
      const cloud = await import("../../src/lib/files/linked-cloud.mjs");
      const identity = cloud.ensureIdentity(home);
      const ctx = { machineId: identity.machineId, name: identity.displayName, platform: "desktop", buildTs: buildTimestamp() };
      const state = store.evaluateLicense(record, ctx);
      if (state.needsRefresh) await store.refreshLicense(home, ctx);
    } catch {
      /* try again at the next tick */
    }
  };
  setTimeout(() => void tick(), 20_000).unref?.();
  setInterval(() => void tick(), 6 * 60 * 60 * 1000).unref?.();
});
