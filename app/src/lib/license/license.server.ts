import os from "node:os";
import { APP_VERSION } from "@/lib/version";
import { buildTimestamp } from "./build-info.mjs";
import { UPGRADE_URL } from "./public-keys.mjs";

/** The data folder this process uses. */
export async function licenseHome(): Promise<string> {
  const store = await import("@/lib/files/linked-store.mjs");
  const fromEnv = store.machineHome();
  if (fromEnv) return fromEnv;
  const settings = await import("@/lib/files/settings.server");
  return settings.resolveDataDir();
}

/** Sync version for hot paths: the data folder this process uses. */
export function licenseHomeSync(): string {
  const env = String(process.env.DRIVEBAY_HOME || process.env.DRIVEBAY_DATA_DIR || "").trim();
  if (env) return env;
  // Same rule as settings.server resolveDataDir, without the async import.
  return process.env.DRIVEBAY_PINOKIO === "true" ? `${process.cwd()}/../data` : `${process.cwd()}/data`;
}

export async function currentEntitlements() {
  const store = await import("./license-store.mjs");
  const home = await licenseHome();
  return store.readEntitlements(home, { buildTs: buildTimestamp() });
}

export async function licenseContext() {
  const home = await licenseHome();
  const cloud = await import("@/lib/files/linked-cloud.mjs");
  const identity = cloud.ensureIdentity(home);
  return {
    home,
    ctx: {
      machineId: identity.machineId as string,
      name: (identity.displayName as string) || os.hostname(),
      platform: process.platform === "win32" ? "pc" : process.platform === "darwin" ? "mac" : "linux",
      version: APP_VERSION,
      buildTs: buildTimestamp(),
    },
  };
}

export { UPGRADE_URL };
