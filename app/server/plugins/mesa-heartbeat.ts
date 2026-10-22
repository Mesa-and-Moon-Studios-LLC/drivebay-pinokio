import { definePlugin } from "nitro";
import { machineHome } from "../../src/lib/files/linked-store.mjs";
import { resolveDataDir } from "../../src/lib/files/settings.server";

/** Refreshes this machine's connection record. It does nothing until Mesa and Moon is configured. */
export default definePlugin(() => {
  const home = machineHome() || resolveDataDir();
  void import("../../src/lib/files/linked-cloud.mjs")
    .then((cloud) => cloud.startHeartbeat({ ...process.env, DRIVEBAY_HOME: home }))
    .catch(() => {});
});