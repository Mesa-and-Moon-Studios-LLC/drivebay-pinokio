import { writeFileSync } from "node:fs";
import path from "node:path";
import { definePlugin } from "nitro";

/**
 * Runs only when this PC starts the server with DRIVEBAY_RESET_PASSWORD=1.
 * There is no HTTP route. A browser cannot call it.
 */
export default definePlugin(() => {
  if (process.env.DRIVEBAY_RESET_PASSWORD !== "1") return;
  const home = String(process.env.DRIVEBAY_HOME || "").trim();
  const resultFile = home ? path.join(home, "reset-result.json") : "";
  void (async () => {
    let code = 1;
    try {
      if (!home || String(process.env.DATABASE_URL || "").trim()) {
        writeResult(resultFile, {
          ok: false,
          username: "",
          reason: "Password reset only changes the account database on this PC.",
        });
      } else {
        const { getSql } = await import("@/lib/db");
        const reset = await import("@/lib/auth/reset-password.mjs");
        const password = await reset.readStdinPassword(process.stdin);
        const sql = await getSql();
        const result = reset.publicResetResult(await reset.resetCredentialPassword(sql, password));
        writeResult(resultFile, result);
        code = result.ok ? 0 : 1;
      }
    } catch {
      writeResult(resultFile, { ok: false, username: "", reason: "Password reset failed." });
      code = 1;
    }
    process.exit(code);
  })();
});

function writeResult(file: string, result: { ok: boolean; username: string; reason: string }) {
  if (!file) return;
  writeFileSync(file, `${JSON.stringify(result)}\n`, { mode: 0o600 });
}
