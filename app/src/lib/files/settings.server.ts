import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { nextPublicAccess, readPublicAccessFile, writePublicAccessFile } from "./public-access.mjs";
import { isIpv4, localLanIpv4 } from "./router-steps.mjs";

export type PortStyle = "random" | "static";

export type PortSettings = {
  style: PortStyle;
  port: number;
};

export type AppSettings = PortSettings & {
  dataDir: string;
  portFile: string;
  lockPersists: true;
};

function fallbackPort(): number {
  const raw = String(process.env.DRIVEBAY_FALLBACK_PORT || process.env.PORT || "42013").trim();
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1024 && n <= 65535 ? n : 42013;
}

export function resolveDataDir(): string {
  const fromEnv = process.env.DRIVEBAY_DATA_DIR?.trim();
  if (fromEnv) return resolve(fromEnv);
  if (process.env.DRIVEBAY_PINOKIO === "true") {
    return resolve(process.cwd(), "..", "data");
  }
  return resolve(process.cwd(), "data");
}

export function resolvePortFile(): string {
  const fromEnv = process.env.DRIVEBAY_PORT_FILE?.trim();
  if (fromEnv) return resolve(fromEnv);
  if (process.env.DRIVEBAY_PINOKIO === "true") {
    return resolve(process.cwd(), "..", "drivebay.port");
  }
  return resolve(process.cwd(), "drivebay.port");
}

export function readPortSettings(): PortSettings {
  try {
    const raw = readFileSync(resolvePortFile(), "utf8").trim().toLowerCase();
    if (raw === "random") return { style: "random", port: fallbackPort() };
    if (/^\d{2,5}$/.test(raw)) return { style: "static", port: Number(raw) };
  } catch {
    /* missing */
  }
  return { style: "random", port: fallbackPort() };
}

export function writePortSettings(style: PortStyle, port: number): PortSettings {
  const file = resolvePortFile();
  mkdirSync(dirname(file), { recursive: true });
  if (style === "random") {
    writeFileSync(file, "random", "utf8");
    return { style: "random", port: fallbackPort() };
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("Port must be between 1024 and 65535");
  }
  writeFileSync(file, String(port), "utf8");
  return { style: "static", port };
}

export function readAppSettings(): AppSettings {
  return {
    ...readPortSettings(),
    dataDir: resolveDataDir(),
    portFile: resolvePortFile(),
    lockPersists: true,
  };
}

export type ReachMode = "regular" | "tailscale" | "both" | "unknown";

export function readReachMode(): ReachMode {
  const env = String(process.env.DRIVEBAY_MODE || "").trim().toLowerCase();
  if (env === "regular" || env === "tailscale" || env === "both") return env;
  try {
    const configPath = resolve(dirname(resolvePortFile()), "config.json");
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as { mode?: string };
    if (raw.mode === "regular" || raw.mode === "tailscale" || raw.mode === "both") return raw.mode;
  } catch {
    /* Pinokio and a fresh folder have no setup mode. */
  }
  return "unknown";
}

export type PublicAccessState = {
  enabled: boolean;
  offAt: number | null;
};

export function resolvePublicAccessFile(): string {
  return resolve(dirname(resolvePortFile()), "public-access.json");
}

export function readPublicAccess(now = Date.now()): PublicAccessState {
  return readPublicAccessFile(resolvePublicAccessFile(), now);
}

export function writePublicAccess(enabled: boolean, hours: number, now = Date.now()): PublicAccessState {
  const next = nextPublicAccess(enabled, hours, now);
  writePublicAccessFile(resolvePublicAccessFile(), next);
  return next;
}

export function thisPcLanIp(): string {
  return localLanIpv4();
}

let publicCache: { at: number; ip: string } | null = null;

export async function lookupPublicIpv4(): Promise<string> {
  if (publicCache && Date.now() - publicCache.at < 10 * 60 * 1000 && publicCache.ip) return publicCache.ip;
  if (publicCache && !publicCache.ip && Date.now() - publicCache.at < 30 * 1000) return "";
  const urls = ["https://api.ipify.org", "https://ifconfig.me/ip"];
  for (const url of urls) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
      const text = (await response.text()).trim();
      if (isIpv4(text)) {
        publicCache = { at: Date.now(), ip: text };
        return text;
      }
    } catch {
      /* The next lookup, or the page, explains that the public IP was not found. */
    }
  }
  publicCache = { at: Date.now(), ip: "" };
  return "";
}
