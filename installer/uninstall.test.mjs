import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function powershell() {
  for (const cmd of ["powershell.exe", "powershell", "pwsh"]) {
    const probe = spawnSync(cmd, ["-NoProfile", "-Command", "Write-Output ok"], { encoding: "utf8" });
    if (probe.status === 0 && String(probe.stdout).includes("ok")) return cmd;
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function alive(pid) {
  if (process.platform !== "win32") {
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      const state = status.match(/^State:\s+(\S+)/m);
      if (state && state[1] === "Z") return false;
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startListener(port) {
  const child = spawn(
    process.execPath,
    ["-e", `const net=require('net'); const s=net.createServer(); s.listen(${port}, '127.0.0.1'); setInterval(()=>{},1000);`],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  return child.pid;
}

function waitForListen(port) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tryOnce = () => {
      const socket = net.connect({ host: "127.0.0.1", port }, () => {
        socket.end();
        resolve();
      });
      socket.on("error", () => {
        if (Date.now() - started > 4000) reject(new Error(`port ${port} did not listen`));
        else setTimeout(tryOnce, 50);
      });
    };
    tryOnce();
  });
}

function runPwsh(ps, file, args, env) {
  return spawnSync(ps, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file, ...args], {
    encoding: "utf8",
    env,
    timeout: 30000,
  });
}

test("uninstall.ps1 is a one-liner script and install runs it first", () => {
  const script = fs.readFileSync(path.join(root, "uninstall.ps1"), "utf8");
  for (const ch of script) {
    assert.ok(ch.charCodeAt(0) <= 127, `non-ASCII ${JSON.stringify(ch)}`);
  }
  assert.notEqual(script.charCodeAt(0), 0xfeff);
  assert.equal(/^\s*param\s*\(/m.test(script), false);
  assert.equal(script.includes("Out-File"), false);
  assert.equal(script.includes("Set-Content"), false);
  assert.equal(/\$home\b/i.test(script), false);
  assert.match(script, /-KeepData/);
  assert.match(script, /-Force/);
  assert.match(script, /Type YES to also delete the saved password and settings/);
  assert.match(script, /Drivebay is uninstalled\./);
  assert.match(script, /taskkill\.exe/);
  assert.match(script, /schtasks\.exe/);
  assert.match(script, /CurrentVersion\\Run/);
  assert.match(script, /Uninstall\\Drivebay/);
  assert.match(script, /Programs/);
  assert.match(script, /Get-ListenerPids/);
  assert.match(script, /DrivebayTray\.exe/);
  assert.match(script, /A Pinokio copy of Drivebay is still running/);
  assert.match(script, /This uninstall leaves Pinokio running/);

  const install = fs.readFileSync(path.join(root, "install.ps1"), "utf8");
  const remove = install.indexOf("Invoke-ExistingUninstall $root");
  const copy = install.indexOf("Copy-ServerFiles $source $root $prebuilt");
  assert.ok(remove !== -1 && copy !== -1 && remove < copy);
  assert.match(install, /Copy-UninstallScript \$root/);
  assert.equal(install.includes("Write-UninstallScript"), false);
  assert.match(install, /The saved account and settings stay/);

  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  assert.ok(
    readme.includes(
      "irm https://raw.githubusercontent.com/lordstryfe/drivebay-pinokio/main/uninstall.ps1 | iex",
    ),
  );
  assert.ok(
    readme.includes(
      'powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/lordstryfe/drivebay-pinokio/main/uninstall.ps1 | iex"',
    ),
  );
  assert.match(readme, /-KeepData/);
  assert.match(readme, /-Force/);
});

test("KeepData removes the program and a missing second run stays quiet", async () => {
  const ps = powershell();
  if (!ps) {
    if (process.platform === "win32") assert.fail("powershell is required on Windows");
    return;
  }
  const port = await freePort();
  const localApp = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-local-"));
  const home = path.join(localApp, "Drivebay");
  const programs = path.join(localApp, "Programs", "Drivebay");
  const menu = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-menu-"));
  const desktop = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-desktop-"));
  const startup = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-startup-"));
  fs.mkdirSync(path.join(home, "app"), { recursive: true });
  fs.mkdirSync(path.join(home, "runtime"), { recursive: true });
  fs.mkdirSync(path.join(home, "data"), { recursive: true });
  fs.mkdirSync(programs, { recursive: true });
  fs.writeFileSync(path.join(home, "app", "old.txt"), "old-server");
  fs.writeFileSync(path.join(home, "runtime", "node.exe"), "");
  fs.writeFileSync(path.join(home, "launcher.mjs"), "// old launcher\n");
  fs.writeFileSync(path.join(home, "DrivebayTray.exe"), "");
  fs.writeFileSync(path.join(home, "start-drivebay.vbs"), "");
  fs.writeFileSync(path.join(home, "uninstall.ps1"), "# old\n");
  fs.writeFileSync(path.join(home, "data", "server-lock.json"), "{}\n");
  fs.writeFileSync(path.join(home, "pending-account.json"), '{"username":"old","password":"old-password-1"}\n');
  fs.writeFileSync(path.join(home, "auth.secret"), "secret");
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ port, mode: "regular" }));
  fs.writeFileSync(path.join(home, "drivebay.port"), String(port));
  fs.writeFileSync(path.join(programs, "DrivebayTray.exe"), "");
  fs.writeFileSync(path.join(programs, "uninstall.exe"), "");
  fs.writeFileSync(path.join(menu, "Drivebay.lnk"), "");
  fs.writeFileSync(path.join(menu, "Stop Drivebay.lnk"), "");
  fs.writeFileSync(path.join(menu, "Uninstall Drivebay.lnk"), "");
  fs.writeFileSync(path.join(desktop, "Drivebay.lnk"), "");
  fs.writeFileSync(path.join(startup, "Drivebay.lnk"), "");
  const pid = startListener(port);
  fs.writeFileSync(path.join(home, "drivebay.pid"), String(pid));
  await waitForListen(port);

  const env = {
    ...process.env,
    LOCALAPPDATA: localApp,
    DRIVEBAY_UNINSTALL_START_MENU: menu,
    DRIVEBAY_UNINSTALL_DESKTOP: desktop,
    DRIVEBAY_UNINSTALL_STARTUP: startup,
  };
  delete env.DRIVEBAY_UNINSTALL_HOME;
  delete env.DRIVEBAY_UNINSTALL_SCOPE;
  delete env.DRIVEBAY_SETUP_HOME;
  delete env.DRIVEBAY_UNINSTALL_FORCE;
  delete env.DRIVEBAY_UNINSTALL_KEEP_DATA;

  try {
    const first = runPwsh(ps, path.join(root, "uninstall.ps1"), ["-KeepData"], env);
    const out = `${first.stdout || ""}\n${first.stderr || ""}`;
    assert.equal(first.status, 0, out);
    assert.equal(/ERROR/i.test(first.stderr || ""), false, out);
    assert.match(first.stdout || "", /Drivebay is uninstalled\./);
    assert.match(first.stdout || "", /saved account and settings are still in/);
    assert.equal(fs.existsSync(path.join(home, "app", "old.txt")), false);
    assert.equal(fs.existsSync(path.join(home, "runtime", "node.exe")), false);
    assert.equal(fs.existsSync(path.join(home, "DrivebayTray.exe")), false);
    assert.equal(fs.existsSync(path.join(home, "launcher.mjs")), false);
    assert.equal(fs.existsSync(path.join(home, "uninstall.ps1")), false);
    assert.equal(fs.existsSync(programs), false);
    assert.equal(fs.existsSync(path.join(menu, "Drivebay.lnk")), false);
    assert.equal(fs.existsSync(path.join(menu, "Uninstall Drivebay.lnk")), false);
    assert.equal(fs.existsSync(path.join(desktop, "Drivebay.lnk")), false);
    assert.equal(fs.existsSync(path.join(startup, "Drivebay.lnk")), false);
    assert.equal(fs.existsSync(path.join(home, "data", "server-lock.json")), true);
    assert.equal(fs.existsSync(path.join(home, "pending-account.json")), true);
    assert.equal(fs.existsSync(path.join(home, "auth.secret")), true);
    assert.equal(alive(pid), false);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const still = await new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port }, () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    assert.equal(still, false);

    const second = runPwsh(ps, path.join(root, "uninstall.ps1"), ["-KeepData"], env);
    const again = `${second.stdout || ""}\n${second.stderr || ""}`;
    assert.equal(second.status, 0, again);
    assert.equal(/ERROR/i.test(second.stderr || ""), false, again);
    assert.match(second.stdout || "", /Drivebay is uninstalled\./);
    assert.equal(fs.existsSync(path.join(home, "data", "server-lock.json")), true);
  } finally {
    if (alive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    fs.rmSync(localApp, { recursive: true, force: true });
    fs.rmSync(menu, { recursive: true, force: true });
    fs.rmSync(desktop, { recursive: true, force: true });
    fs.rmSync(startup, { recursive: true, force: true });
  }
});

test("a node listening on the saved port stops when the pid file is missing", async () => {
  const ps = powershell();
  if (!ps) {
    if (process.platform === "win32") assert.fail("powershell is required on Windows");
    return;
  }
  const port = await freePort();
  const localApp = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-port-"));
  const home = path.join(localApp, "Drivebay");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ port }));
  fs.writeFileSync(path.join(home, "drivebay.port"), String(port));
  fs.writeFileSync(path.join(home, "pending-account.json"), '{"username":"old","password":"old-password-1"}\n');
  const pid = startListener(port);
  await waitForListen(port);
  const env = { ...process.env, LOCALAPPDATA: localApp };
  delete env.DRIVEBAY_UNINSTALL_HOME;
  delete env.DRIVEBAY_UNINSTALL_SCOPE;
  delete env.DRIVEBAY_SETUP_HOME;
  delete env.DRIVEBAY_UNINSTALL_FORCE;
  delete env.DRIVEBAY_UNINSTALL_KEEP_DATA;
  try {
    const result = runPwsh(ps, path.join(root, "uninstall.ps1"), ["-KeepData"], env);
    const out = `${result.stdout || ""}\n${result.stderr || ""}`;
    assert.equal(result.status, 0, out);
    assert.equal(/ERROR/i.test(result.stderr || ""), false, out);
    assert.match(result.stdout || "", /Drivebay is uninstalled\./);
    assert.equal(alive(pid), false);
    assert.equal(fs.existsSync(path.join(home, "pending-account.json")), true);
  } finally {
    if (alive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    fs.rmSync(localApp, { recursive: true, force: true });
  }
});

test("uninstall mentions a Pinokio copy that is still running", async () => {
  const ps = powershell();
  if (!ps) {
    if (process.platform === "win32") assert.fail("powershell is required on Windows");
    return;
  }
  const localApp = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-pinokio-"));
  const home = path.join(localApp, "Drivebay");
  fs.mkdirSync(path.join(home, "app"), { recursive: true });
  fs.writeFileSync(path.join(home, "app", "old.txt"), "old");
  const child = spawn(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)", "pinokio", "drivebay"],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  const env = { ...process.env, LOCALAPPDATA: localApp };
  delete env.DRIVEBAY_UNINSTALL_HOME;
  delete env.DRIVEBAY_UNINSTALL_SCOPE;
  delete env.DRIVEBAY_SETUP_HOME;
  delete env.DRIVEBAY_UNINSTALL_FORCE;
  delete env.DRIVEBAY_UNINSTALL_KEEP_DATA;
  try {
    const result = runPwsh(ps, path.join(root, "uninstall.ps1"), ["-KeepData"], env);
    const out = `${result.stdout || ""}\n${result.stderr || ""}`;
    assert.equal(result.status, 0, out);
    assert.equal(/ERROR/i.test(result.stderr || ""), false, out);
    assert.match(result.stdout || "", /A Pinokio copy of Drivebay is still running/);
    assert.match(result.stdout || "", /This uninstall leaves Pinokio running/);
    assert.match(result.stdout || "", /Drivebay is uninstalled\./);
    assert.equal(alive(child.pid), true);
    assert.equal(fs.existsSync(path.join(home, "app", "old.txt")), false);
  } finally {
    try { process.kill(child.pid, "SIGKILL"); } catch { /* already gone */ }
    fs.rmSync(localApp, { recursive: true, force: true });
  }
});

test("Force deletes the saved account and settings", async () => {
  const ps = powershell();
  if (!ps) {
    if (process.platform === "win32") assert.fail("powershell is required on Windows");
    return;
  }
  const localApp = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-force-"));
  const home = path.join(localApp, "Drivebay");
  fs.mkdirSync(path.join(home, "app"), { recursive: true });
  fs.mkdirSync(path.join(home, "data"), { recursive: true });
  fs.writeFileSync(path.join(home, "data", "server-lock.json"), "{}\n");
  fs.writeFileSync(path.join(home, "pending-account.json"), '{"username":"old","password":"old-password-1"}\n');
  fs.writeFileSync(path.join(home, "app", "old.txt"), "x");
  const env = {
    ...process.env,
    LOCALAPPDATA: localApp,
  };
  delete env.DRIVEBAY_UNINSTALL_HOME;
  delete env.DRIVEBAY_UNINSTALL_SCOPE;
  delete env.DRIVEBAY_SETUP_HOME;
  delete env.DRIVEBAY_UNINSTALL_KEEP_DATA;
  try {
    const result = runPwsh(ps, path.join(root, "uninstall.ps1"), ["-Force"], env);
    const out = `${result.stdout || ""}\n${result.stderr || ""}`;
    assert.equal(result.status, 0, out);
    assert.equal(/ERROR/i.test(result.stderr || ""), false, out);
    assert.match(result.stdout || "", /saved account and settings were deleted/);
    assert.match(result.stdout || "", /Drivebay is uninstalled\./);
    assert.equal(fs.existsSync(path.join(home, "pending-account.json")), false);
    assert.equal(fs.existsSync(path.join(home, "data", "server-lock.json")), false);
    assert.equal(fs.existsSync(home), false);
  } finally {
    fs.rmSync(localApp, { recursive: true, force: true });
  }
});

test("install.ps1 updates an existing install and keeps the account", async () => {
  const ps = powershell();
  if (!ps) {
    if (process.platform === "win32") assert.fail("powershell is required on Windows");
    return;
  }
  const port = await freePort();
  const oldPort = await freePort();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-reinstall-"));
  const decoyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-decoy-"));
  const decoy = path.join(decoyRoot, "Programs", "Drivebay");
  fs.mkdirSync(path.join(home, "app"), { recursive: true });
  fs.mkdirSync(path.join(home, "data"), { recursive: true });
  fs.mkdirSync(decoy, { recursive: true });
  fs.writeFileSync(path.join(home, "app", "old.txt"), "old-server");
  fs.writeFileSync(path.join(home, "DrivebayTray.exe"), "");
  fs.writeFileSync(path.join(home, "data", "server-lock.json"), '{"allowUpload":false}\n');
  fs.writeFileSync(path.join(home, "pending-account.json"), '{"username":"old","password":"old-password-1"}\n');
  fs.writeFileSync(path.join(home, "drivebay.port"), String(oldPort));
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ port: oldPort, mode: "tailscale", version: "3.20", note: "keep-me" }),
  );
  fs.writeFileSync(path.join(decoy, "marker.txt"), "exe-install");
  const pid = startListener(oldPort);
  fs.writeFileSync(path.join(home, "drivebay.pid"), String(pid));
  await waitForListen(oldPort);
  const password = "reinstall-pass-1";
  try {
    const result = spawnSync(ps, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "install.ps1")], {
      encoding: "utf8",
      timeout: 30000,
      env: {
        ...process.env,
        LOCALAPPDATA: decoyRoot,
        DRIVEBAY_SETUP_ONLY: "1",
        DRIVEBAY_SETUP_SOURCE: root,
        DRIVEBAY_SETUP_HOME: home,
        DRIVEBAY_SETUP_PORT: String(port),
        DRIVEBAY_SETUP_USER: "alice",
        DRIVEBAY_SETUP_MODE: "regular",
        DRIVEBAY_SETUP_PASSWORD: password,
        DRIVEBAY_SETUP_ACK: "YES",
        DRIVEBAY_TAILSCALE: "install",
        DRIVEBAY_SKIP_START: "1",
      },
    });
    const out = `${result.stdout || ""}\n${result.stderr || ""}`;
    assert.equal(result.status, 0, out);
    assert.match(result.stdout || "", /saved account and settings stay/);
    assert.match(result.stdout || "", /Drivebay is uninstalled\./);
    assert.match(result.stdout || "", /Drivebay updated to 3\.21/);
    assert.equal((result.stdout || "").includes("Drivebay is ready"), false);
    assert.equal(out.includes("Enter a different port"), false);
    assert.equal(out.includes("Saving the Drivebay account"), false);
    assert.equal(out.includes("Downloading the official Tailscale installer"), false);
    assert.equal(fs.existsSync(path.join(home, "app", "old.txt")), false);
    assert.equal(fs.existsSync(path.join(home, "DrivebayTray.exe")), false);
    assert.equal(fs.readFileSync(path.join(home, "data", "server-lock.json"), "utf8").includes("allowUpload"), true);
    assert.equal(fs.existsSync(path.join(decoy, "marker.txt")), true);
    const pending = JSON.parse(fs.readFileSync(path.join(home, "pending-account.json"), "utf8"));
    assert.equal(pending.username, "old");
    assert.equal(pending.password, "old-password-1");
    const config = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
    assert.equal(config.port, oldPort);
    assert.equal(config.mode, "tailscale");
    assert.equal(config.version, "3.21");
    assert.equal(config.note, "keep-me");
    assert.equal(fs.readFileSync(path.join(home, "drivebay.port"), "utf8").trim(), String(oldPort));
    const installed = fs.readFileSync(path.join(home, "uninstall.ps1"), "utf8");
    assert.equal(installed.includes(password), false);
    assert.equal(installed.includes("old-password-1"), false);
    assert.match(installed, /Type YES to also delete the saved password and settings/);
    assert.match(installed, /-KeepData/);
    assert.equal(alive(pid), false);
  } finally {
    if (alive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(decoyRoot, { recursive: true, force: true });
  }
});
