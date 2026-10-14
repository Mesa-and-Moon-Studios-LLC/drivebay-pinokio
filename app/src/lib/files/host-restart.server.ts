import { spawn } from "node:child_process";

/**
 * Start Drivebay again after this process exits.
 * The launcher path is set only by the standalone Windows launcher.
 * Pinokio does not set it; the caller tells the user to stop and start there.
 */
export function scheduleStandaloneRestart(): { ok: true } | { ok: false; message: string } {
  const launcher = process.env.DRIVEBAY_LAUNCHER?.trim();
  if (!launcher) {
    return {
      ok: false,
      message: "Stop Drivebay and start it again. This start method cannot restart itself.",
    };
  }
  const port = String(process.env.PORT || process.env.NITRO_PORT || "8765");
  const script = `
    const { spawn } = require("node:child_process");
    const net = require("node:net");
    const launcher = ${JSON.stringify(launcher)};
    const port = ${JSON.stringify(port)};
    function portFree() {
      return new Promise((resolve) => {
        const socket = net.connect({ host: "127.0.0.1", port: Number(port) }, () => {
          socket.destroy();
          resolve(false);
        });
        socket.on("error", () => resolve(true));
      });
    }
    (async () => {
      for (let i = 0; i < 40; i++) {
        if (await portFree()) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const child = spawn(process.execPath, [launcher], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: Object.assign({}, process.env, { DRIVEBAY_NO_BROWSER: "1" }),
      });
      child.unref();
    })();
  `;
  const child = spawn(process.execPath, ["-e", script], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, DRIVEBAY_NO_BROWSER: "1" },
  });
  child.unref();
  setTimeout(() => {
    process.exit(0);
  }, 1500);
  return { ok: true };
}
