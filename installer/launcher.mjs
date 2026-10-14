/**
 * Starts the production Drivebay server that the Windows installer ships.
 * Pinokio does not call this file. It still uses run-dev.cjs.
 *
 * The password lock is the app's normal Better Auth account. If setup wrote
 * pending-account.json, this process creates that one account through the
 * sign-up API and then deletes the file. It does not disable auth.
 */
import { spawn, execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPortFree, readConfig, readJson, resolveListenPort, usernameToEmail } from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function defaultHome() {
  if (process.env.DRIVEBAY_HOME) return path.resolve(process.env.DRIVEBAY_HOME);
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "Drivebay");
  }
  return path.join(os.homedir(), ".local", "share", "drivebay");
}

function appDir() {
  if (process.env.DRIVEBAY_APP_DIR) return path.resolve(process.env.DRIVEBAY_APP_DIR);
  return path.join(here, "app");
}

function logPath(home) {
  return path.join(home, "drivebay.log");
}

function log(home, message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.appendFileSync(logPath(home), line);
  } catch {
    /* logging must not crash startup */
  }
  console.log(message);
}

function shred(file) {
  try {
    const size = fs.statSync(file).size;
    fs.writeFileSync(file, Buffer.alloc(Math.max(size, 1)));
  } catch {
    /* already gone */
  }
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* already gone */
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(home) {
  try {
    const pid = Number(String(fs.readFileSync(path.join(home, "drivebay.pid"), "utf8")).trim());
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

function stopProcess(pid) {
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
    });
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already stopped */
  }
  return Promise.resolve();
}

async function fetchText(url) {
  const res = await fetch(url, { redirect: "manual" });
  const text = await res.text();
  return { status: res.status, text };
}

function looksLikeDrivebay(body) {
  return /Drivebay/i.test(body);
}

function openBrowser(url) {
  if (process.env.DRIVEBAY_NO_BROWSER === "1") return;
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, windowsHide: true, stdio: "ignore" }).unref();
    return;
  }
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
}

function alertUser(home, message) {
  log(home, message);
  if (process.env.DRIVEBAY_NO_BROWSER === "1" || process.platform !== "win32") return;
  const safe = message.replace(/'/g, "''");
  spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('${safe}','Drivebay')`,
    ],
    { windowsHide: true, stdio: "ignore" },
  ).unref();
}

function authSecret(home) {
  const file = path.join(home, "auth.secret");
  try {
    const cur = fs.readFileSync(file, "utf8").trim();
    if (cur.length >= 32) return cur;
  } catch {
    /* create below */
  }
  const secret = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  return secret;
}

async function ensureAccount(home, origin) {
  const pending = path.join(home, "pending-account.json");
  if (!fs.existsSync(pending)) return "none";
  let parsed;
  try {
    parsed = readJson(pending);
  } catch (err) {
    log(home, `Could not read the setup account file (${err.message}). Set the password in the browser.`);
    shred(pending);
    return "rejected";
  }
  const username = String(parsed.username ?? "").trim();
  const password = String(parsed.password ?? "");
  if (!username || password.length < 8) {
    log(home, "Setup account was rejected. Username is required and the password must be at least 8 characters.");
    shred(pending);
    return "rejected";
  }
  let email;
  try {
    email = usernameToEmail(username);
  } catch (err) {
    log(home, err.message);
    shred(pending);
    return "rejected";
  }

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${origin}/api/auth/sign-up/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          referer: `${origin}/login`,
        },
        body: JSON.stringify({ email, password, name: username }),
      });
      const text = await res.text();
      if (res.status === 200) {
        shred(pending);
        log(home, "Drivebay account created. Sign in with that username and password.");
        return "created";
      }
      if (res.status === 403) {
        shred(pending);
        log(home, "An account already exists. The password from setup was not changed. Sign in with the existing password.");
        return "exists";
      }
      if (res.status === 400 || res.status === 422) {
        shred(pending);
        log(home, `Could not create the account (${res.status}). Set it in the browser. ${text.slice(0, 240)}`);
        return "rejected";
      }
      log(home, `Waiting to create the account (HTTP ${res.status}).`);
    } catch (err) {
      log(home, `Waiting for Drivebay to finish starting (${err.message}).`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  shred(pending);
  log(home, "Timed out creating the account. Set the username and password in the browser.");
  return "timeout";
}

async function waitForLogin(origin, home, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetchText(`${origin}/login`);
      if (res.status === 200 && looksLikeDrivebay(res.text)) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  log(home, "Drivebay did not serve the login page in time. See drivebay.log.");
  return false;
}

async function stop(home) {
  const pid = readPid(home);
  if (pid && pidAlive(pid) && pid !== process.pid) {
    await stopProcess(pid);
  }
  try {
    fs.rmSync(path.join(home, "drivebay.pid"), { force: true });
  } catch {
    /* ignore */
  }
}

async function main() {
  const home = defaultHome();
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(home, "data"), { recursive: true });

  if (process.argv.includes("--stop")) {
    await stop(home);
    return;
  }

  let config;
  try {
    config = readConfig(home);
  } catch (err) {
    log(home, `Setup config was not found (${err.message}). Using port 8765 so the login page can still open.`);
    config = { port: 8765, mode: "regular", version: "" };
  }
  const port = resolveListenPort(home, config.port);
  const origin = `http://127.0.0.1:${port}`;
  const existing = readPid(home);
  if (existing && pidAlive(existing) && existing !== process.pid) {
    const ready = await waitForLogin(origin, home, 4_000);
    if (ready) {
      log(home, `Drivebay is already running. This PC opens settings at ${origin}/settings`);
      if (config.mode === "tailscale") {
        log(home, `Tailscale: other devices on your tailnet use http://<this-pc-tailscale-name>:${port}/`);
      } else if (config.mode === "both") {
        log(
          home,
          `Tailscale + Local: Tailscale stays open. Public access starts off until you turn it on from this PC or over Tailscale.`,
        );
      } else {
        log(home, `Forward TCP port ${port} on your router if other devices cannot connect.`);
      }
      openBrowser(`${origin}/settings`);
      return;
    }
  }
  try {
    fs.rmSync(path.join(home, "drivebay.pid"), { force: true });
  } catch {
    /* ignore */
  }

  const free = await isPortFree(port);
  if (!free) {
    alertUser(
      home,
      `Port ${port} is already in use, so Drivebay did not start. Pick a free port in the installer or in Settings.`,
    );
    process.exitCode = 1;
    return;
  }

  const serverEntry = path.join(appDir(), "server", "index.mjs");
  if (!fs.existsSync(serverEntry)) {
    alertUser(home, `Drivebay's server is missing: ${serverEntry}`);
    process.exitCode = 1;
    return;
  }

  fs.writeFileSync(path.join(home, "drivebay.pid"), String(process.pid));
  const logFd = fs.openSync(logPath(home), "a");
  const secret = authSecret(home);
  const serverEnv = {
    ...process.env,
    DRIVEBAY_STANDALONE: "true",
      DRIVEBAY_LAUNCHER: fileURLToPath(import.meta.url),
      DRIVEBAY_HOME: home,
      DRIVEBAY_DATA_DIR: path.join(home, "data"),
      DRIVEBAY_PORT_FILE: path.join(home, "drivebay.port"),
      DRIVEBAY_FALLBACK_PORT: String(port),
      DRIVEBAY_MODE: config.mode === "tailscale" || config.mode === "both" ? config.mode : "regular",
      PORT: String(port),
      NITRO_PORT: String(port),
      HOST: "0.0.0.0",
      NITRO_HOST: "0.0.0.0",
      BETTER_AUTH_SECRET: secret,
      VITE_AUTH_ENABLED: "true",
  };
  delete serverEnv.DRIVEBAY_PINOKIO;
  const child = spawn(process.execPath, [serverEntry], {
    cwd: appDir(),
    windowsHide: true,
    stdio: ["ignore", logFd, logFd],
    env: serverEnv,
  });

  const shutdown = (code) => {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already stopped */
    }
    try {
      fs.rmSync(path.join(home, "drivebay.pid"), { force: true });
    } catch {
      /* ignore */
    }
    process.exit(code);
  };
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));
  child.on("exit", (code) => {
    log(home, `Drivebay server exited (${code ?? 0}).`);
    try {
      fs.rmSync(path.join(home, "drivebay.pid"), { force: true });
    } catch {
      /* ignore */
    }
    process.exit(code == null ? 0 : code);
  });

  log(home, `Starting Drivebay on port ${port} (${config.mode}).`);
  if (config.mode === "tailscale") {
    log(
      home,
      `Tailscale mode: devices on your tailnet reach this PC at http://<this-pc-tailscale-name>:${port}/. No router port forward is required.`,
    );
  } else if (config.mode === "both") {
    log(
      home,
      `Tailscale + Local (Both): Tailscale stays open at http://<this-pc-tailscale-name>:${port}/. Public access starts off. Forward TCP port ${port} before that path can work.`,
    );
  } else {
    log(home, `You must open and forward TCP port ${port} on your router.`);
  }

  const up = await waitForLogin(origin, home);
  if (!up) {
    alertUser(home, "Drivebay did not start. Open drivebay.log in the Drivebay data folder.");
    shutdown(1);
  }
  await ensureAccount(home, origin);
  // This PC opens settings. Other devices still use the shared address for the file browser.
  openBrowser(`${origin}/settings`);
  child.ref();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
