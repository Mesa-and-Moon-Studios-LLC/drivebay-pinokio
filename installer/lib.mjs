import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const PORT_MIN = 1024;
const PORT_MAX = 65535;

/** Same local-part rule as app/src/lib/files/identity.ts */
export function usernameToEmail(username) {
  const trimmed = String(username ?? "").trim().toLowerCase();
  if (!trimmed) throw new Error("Username is required");
  if (trimmed.includes("@")) return trimmed;
  return `${trimmed}@drivebay.local`;
}

/**
 * Static port used for router forwarding.
 * Matches save-port.cjs: integers from 1024 through 65535.
 */
export function parsePort(value) {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error("Port must be a number from 1024 to 65535.");
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) {
    throw new Error("Port must be a number from 1024 to 65535.");
  }
  return port;
}

/**
 * True when nothing is accepting this port.
 * A connect probe runs first. On Windows a bind can succeed while Caddy
 * (SO_REUSEADDR) is already listening, so a successful bind is not enough.
 */
export function isPortFree(port) {
  const checked = parsePort(port);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (free) => {
      if (settled) return;
      settled = true;
      resolve(free);
    };
    const probe = net.connect({ host: "127.0.0.1", port: checked });
    probe.unref();
    const tryBind = () => {
      probe.removeAllListeners();
      probe.destroy();
      const server = net.createServer();
      server.unref();
      server.once("error", () => finish(false));
      server.listen({ port: checked, host: "0.0.0.0", exclusive: true }, () => {
        server.close(() => finish(true));
      });
    };
    probe.once("connect", () => {
      probe.destroy();
      finish(false);
    });
    probe.once("error", () => tryBind());
    probe.setTimeout(400, () => tryBind());
  });
}

export function readJson(file) {
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(text);
}

export function readConfig(home) {
  const raw = readJson(path.join(home, "config.json"));
  const mode = raw.mode === "tailscale" || raw.mode === "both" || raw.mode === "regular" ? raw.mode : "regular";
  return {
    port: parsePort(raw.port),
    mode,
    version: raw.version == null ? "" : String(raw.version),
  };
}

/** Settings can rewrite drivebay.port. Random is ignored so the forwarded port stays put. */
export function resolveListenPort(home, configPort) {
  const file = path.join(home, "drivebay.port");
  try {
    const raw = fs.readFileSync(file, "utf8").trim().toLowerCase();
    if (raw && raw !== "random") return parsePort(raw);
  } catch {
    /* missing */
  }
  return configPort;
}
