import { definePlugin } from "nitro";
import { machineHome } from "../../src/lib/files/linked-store.mjs";
import { resolveDataDir } from "../../src/lib/files/settings.server";

/** Remounts linked own machines in Explorer or Finder when Drivebay starts. */
export default definePlugin(() => {
  const home = machineHome() || resolveDataDir();
  void import("../../src/lib/files/linked-explorer.mjs")
    .then((explorer) => explorer.startLinkedExplorer(home))
    .catch(() => {});
});
