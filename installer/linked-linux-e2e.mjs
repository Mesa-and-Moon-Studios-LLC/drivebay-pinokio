/**
 * Launch two production servers and check Mesa sign-in, registration, and WebDAV.
 * Run after `DRIVEBAY_STANDALONE=1 npm run build` in app/.
 * Email sign-in is checked in the served Settings bundle and against a loopback
 * Identity Toolkit stand-in. The password never lands in the data directory.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLOUD_KEYS, newMachineKeys } from "../app/src/lib/files/linked-machines.mjs";
import { issueLocalCode } from "../app/src/lib/files/linked-http.mjs";
import { saveAccount, saveIdentity, saveShares, writePrivate } from "../app/src/lib/files/linked-store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const appOutput = path.resolve(here, "../app/.output");
const allowed = new Set(CLOUD_KEYS);

function jwt(projectId, uid, email) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: uid,
      aud: projectId,
      email,
      exp: Math.floor(Date.now() / 1000) + 3600,
      firebase: { sign_in_provider: "password" },
    }),
  ).toString("base64url");
  return `${header}.${payload}.sig`;
}

function pickPort(start) {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(start, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", () => {
      server.close();
      pickPort(start + 1).then(resolve, reject);
    });
  });
}

async function waitFor(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = "not ready";
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(last);
}

function startServer(home) {
  return spawn(process.execPath, [path.join(here, "launcher.mjs")], {
    env: { ...process.env, DRIVEBAY_HOME: home, DRIVEBAY_APP_DIR: appOutput, DRIVEBAY_NO_BROWSER: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function stopServer(child, home) {
  const stopper = spawn(process.execPath, [path.join(here, "launcher.mjs"), "--stop"], {
    env: { ...process.env, DRIVEBAY_HOME: home, DRIVEBAY_NO_BROWSER: "1" },
    stdio: "ignore",
  });
  await new Promise((resolve) => stopper.on("exit", resolve));
  child.kill("SIGTERM");
}

async function main() {
  if (!fs.existsSync(path.join(appOutput, "server/index.mjs"))) {
    console.error("Missing app/.output. Build with DRIVEBAY_STANDALONE=1 first.");
    process.exit(1);
  }
  const copy = spawn(process.execPath, [path.join(here, "copy-pglite-assets.mjs")], { stdio: "inherit" });
  const copyCode = await new Promise((resolve) => copy.on("exit", resolve));
  if (copyCode !== 0) process.exit(copyCode ?? 1);

  const posts = [];
  const cloud = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (req.method === "POST" && req.url.startsWith("/machines.php")) {
        const body = JSON.parse(raw || "{}");
        posts.push({ auth: req.headers.authorization || "", body });
        const extra = Object.keys(body).filter((key) => !allowed.has(key));
        if (extra.length || !String(req.headers.authorization || "").startsWith("Bearer ")) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "not connection info", extra }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "GET" && req.url.startsWith("/machines.php")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ machines: [] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((resolve) => cloud.listen(0, "127.0.0.1", resolve));
  const cloudPort = cloud.address().port;
  const cloudApi = `http://127.0.0.1:${cloudPort}`;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-e2e-"));
  const homeA = path.join(root, "a");
  const homeB = path.join(root, "b");
  const portA = await pickPort(46000);
  const portB = await pickPort(portA + 1);
  const password = "local-lock-pass-1";
  const mesaPassword = "email-secret-not-stored";

  function prepare(home, port, machineId, displayName, username) {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ port, mode: "regular", version: "3.38.1" }));
    fs.writeFileSync(path.join(home, "drivebay.port"), String(port));
    fs.writeFileSync(path.join(home, "pending-account.json"), JSON.stringify({ username, password }));
    writePrivate(path.join(home, "mesa-firebase.json"), {
      apiKey: "demo-key",
      authDomain: "demo.firebaseapp.com",
      projectId: "mesa-demo",
      cloudApi,
      authEmulator: "http://127.0.0.1:9",
    });
    const token = jwt("mesa-demo", `uid-${machineId}`, `${username}@example.com`);
    saveAccount(home, {
      uid: `uid-${machineId}`,
      email: `${username}@example.com`,
      displayName: username,
      idToken: token,
      refreshToken: `refresh-${machineId}`,
      expiresAt: Date.now() + 3600_000,
    });
    const keys = newMachineKeys();
    saveIdentity(home, { machineId, displayName, ...keys });
    fs.writeFileSync(path.join(home, "not-the-password.txt"), mesaPassword);
  }

  prepare(homeA, portA, "machine-office-1", "Aaron's Mac Mini", "owner-a");
  prepare(homeB, portB, "machine-laptop-1", "Aaron's Laptop", "owner-b");
  const photos = path.join(homeA, "Photos");
  const docs = path.join(homeA, "Docs");
  fs.mkdirSync(photos);
  fs.mkdirSync(docs);
  fs.writeFileSync(path.join(photos, "cat.txt"), "cat");
  saveShares(homeA, {
    folders: [
      { path: photos, access: "ro", name: "Photos" },
      { path: docs, access: "rw", name: "Docs" },
    ],
  });
  issueLocalCode(homeA, "654321");

  const childA = startServer(homeA);
  const childB = startServer(homeB);
  const originA = `http://127.0.0.1:${portA}`;
  const originB = `http://127.0.0.1:${portB}`;

  try {
    const healthA = await waitFor(async () => {
      const res = await fetch(`${originA}/api/health`);
      if (!res.ok) return null;
      const body = await res.json();
      return body.version === "3.38.1" ? body : null;
    }, 90_000);
    const healthB = await waitFor(async () => {
      const res = await fetch(`${originB}/api/health`);
      if (!res.ok) return null;
      const body = await res.json();
      return body.version === "3.38.1" ? body : null;
    }, 90_000);
    console.log(`health ${healthA.version} and ${healthB.version}`);

    const login = await fetch(`${originA}/login`);
    const loginHtml = await login.text();
    const scripts = [...loginHtml.matchAll(/\/assets\/[^"' ]+\.js/g)].map((match) => match[0]);
    let settingsJs = "";
    for (const script of scripts) {
      const text = await (await fetch(`${originA}${script}`)).text();
      const nested = text.match(/assets\/settings-[^"' ]+\.js/);
      if (nested) {
        settingsJs = await (await fetch(`${originA}/${nested[0]}`)).text();
        break;
      }
      if (text.includes("Continue with Google")) settingsJs = text;
    }
    if (!settingsJs) throw new Error(`Settings bundle was not referenced from ${scripts.join(", ") || "the login page"}`);
    for (const phrase of ["Continue with Google", "Continue with Apple", "Create account", "Email me a reset link"]) {
      if (!settingsJs.includes(phrase)) throw new Error(`Settings bundle is missing ${phrase}`);
    }
    if (settingsJs.includes(mesaPassword)) throw new Error("The email password was bundled");
    console.log("settings bundle has Google, Apple, and email");

    const accountFile = fs.readFileSync(path.join(homeA, "mesa-account.json"), "utf8");
    if (accountFile.includes(mesaPassword)) throw new Error("The email password was stored");
    console.log("mesa-account.json has tokens and not the email password");

    const posted = await waitFor(async () => posts.find((row) => row.body.machineId === "machine-office-1"), 30_000);
    if (posted.body.displayName !== "Aaron's Mac Mini") throw new Error(`display name ${posted.body.displayName}`);
    if (JSON.stringify(posted.body).includes(mesaPassword)) throw new Error("registration included the password");
    if (posted.body.folders || posted.body.token || posted.body.password) throw new Error("registration was not connection info");
    console.log(`registered ${posted.body.displayName} via ${posted.body.tailscaleHost || posted.body.lanAddress || "no-address"}:${posted.body.port}`);

    const redeemed = await fetch(`${originA}/api/link/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "654321", machineId: "machine-laptop-1", displayName: "Aaron's Laptop" }),
    });
    const redeemedBody = await redeemed.json();
    if (redeemed.status !== 200 || !String(redeemedBody.token || "").startsWith("dbp_")) {
      throw new Error(`redeem ${redeemed.status} ${JSON.stringify(redeemedBody)}`);
    }
    const auth = `Basic ${Buffer.from(`drivebay:${redeemedBody.token}`).toString("base64")}`;
    const listed = await fetch(`${originA}/dav/`, { method: "PROPFIND", headers: { Authorization: auth, Depth: "1" } });
    const xml = await listed.text();
    if (listed.status !== 207 || !xml.includes("Aaron's Mac Mini") || !xml.includes("Photos") || xml.includes("Secret")) {
      throw new Error(`propfind ${listed.status} ${xml.slice(0, 400)}`);
    }
    const denied = await fetch(`${originA}/dav/Photos/new.txt`, {
      method: "PUT",
      headers: { Authorization: auth },
      body: "no",
    });
    if (denied.status !== 403) throw new Error(`read-only put ${denied.status}`);
    const allowedWrite = await fetch(`${originA}/dav/Docs/hello.txt`, {
      method: "PUT",
      headers: { Authorization: auth },
      body: "hello from laptop",
    });
    if (allowedWrite.status !== 201 && allowedWrite.status !== 204) {
      throw new Error(`read-write put ${allowedWrite.status}`);
    }
    const readBack = await fetch(`${originA}/dav/Docs/hello.txt`, { headers: { Authorization: auth } });
    if ((await readBack.text()) !== "hello from laptop") throw new Error("read-write file did not round-trip");
    console.log(`paired ${originB} to ${originA}; read-only rejected, read-write mounted over WebDAV`);
    console.log("linux linked-machine e2e passed");
  } catch (err) {
    console.error(err);
    for (const home of [homeA, homeB]) {
      const logFile = path.join(home, "drivebay.log");
      if (fs.existsSync(logFile)) console.error(fs.readFileSync(logFile, "utf8").slice(-2500));
    }
    process.exitCode = 1;
  } finally {
    await stopServer(childA, homeA);
    await stopServer(childB, homeB);
    await new Promise((resolve) => cloud.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
