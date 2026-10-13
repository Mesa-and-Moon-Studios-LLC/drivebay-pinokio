import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { pageAfterSignIn } from "../app/src/lib/host-page.mjs";
import { readyLine } from "../run-dev.cjs";

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

function pinokioRegex(startSrc) {
  const raw = startSrc.match(/event:\s*"([\s\S]+?)"/);
  assert.ok(raw, "start.js is missing the ready event");
  const literal = JSON.parse(`"${raw[1]}"`);
  const inner = literal.match(/^\/([\s\S]+)\/$/);
  assert.ok(inner, "ready event is not a /regex/");
  return new RegExp(inner[1]);
}

test("this PC lands on settings and other devices keep the file browser", () => {
  assert.equal(pageAfterSignIn("127.0.0.1", null), "/settings");
  assert.equal(pageAfterSignIn("localhost", null), "/settings");
  assert.equal(pageAfterSignIn("::1", null), "/settings");
  assert.equal(pageAfterSignIn("[::1]", null), "/settings");
  assert.equal(pageAfterSignIn("100.64.0.2", null), "/");
  assert.equal(pageAfterSignIn("192.168.1.20", null), "/");
  assert.equal(pageAfterSignIn("192.168.1.20", "/settings"), "/settings");
});

test("Windows start announces settings and does not match the file browser URL", () => {
  assert.equal(readyLine(42013, "win32"), "Drivebay ready http://127.0.0.1:42013/settings");
  assert.equal(readyLine(42013, "linux"), "Drivebay ready http://127.0.0.1:42013/");
  const start = fs.readFileSync(path.join(root, "start.js"), "utf8");
  const re = pinokioRegex(start);
  const settings = re.exec(readyLine(42013, "win32"));
  assert.ok(settings);
  assert.equal(settings[1], "http://127.0.0.1:42013/settings");
  const other = re.exec(readyLine(42013, "darwin"));
  assert.ok(other);
  assert.equal(other[1], "http://127.0.0.1:42013");
  assert.equal(re.exec("Local: http://127.0.0.1:42013/"), null);
  assert.equal(re.exec("Local: http://localhost:42013/"), null);
});

test("install.ps1 stays ASCII and the README has both one-liners", () => {
  const script = fs.readFileSync(path.join(root, "install.ps1"), "utf8");
  for (const ch of script) {
    assert.ok(ch.charCodeAt(0) <= 127, `non-ASCII ${JSON.stringify(ch)}`);
  }
  assert.notEqual(script.charCodeAt(0), 0xfeff);
  assert.match(script, /write-setup\.ps1/);
  assert.equal(script.includes("Out-File"), false);
  assert.equal(script.includes("Set-Content"), false);
  assert.match(script, /UTF8Encoding \$false|UTF8Encoding \$false/);
  assert.match(script, /You do not open that port on your router/);
  assert.match(script, /You have to open and forward TCP port/);
  const routerFn = script.slice(
    script.indexOf("function Confirm-RouterForward"),
    script.indexOf("function Read-YesNo"),
  );
  const tail = routerFn.indexOf('if ($Mode -eq "tailscale")');
  const yes = routerFn.indexOf("Type YES");
  assert.ok(tail !== -1 && yes !== -1 && tail < yes);
  assert.match(script, /WScript\.Shell/);
  assert.match(script, /Drivebay\.lnk/);
  assert.match(script, /uninstall\.ps1/);

  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  assert.ok(
    readme.includes(
      "irm https://raw.githubusercontent.com/lordstryfe/drivebay-pinokio/main/install.ps1 | iex",
    ),
  );
  assert.ok(
    readme.includes(
      'powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/lordstryfe/drivebay-pinokio/main/install.ps1 | iex"',
    ),
  );

  const tray = fs.readFileSync(path.join(root, "installer/tray/DrivebayTray.cs"), "utf8");
  assert.match(tray, /ReadPort\(\) \+ "\/settings"/);
  assert.doesNotMatch(tray, /ReadPort\(\) \+ "\/login"/);
  assert.match(tray, /openWhenReady = true;\s*StartServer\(true\);/);
  const launcher = fs.readFileSync(path.join(root, "installer/launcher.mjs"), "utf8");
  assert.equal(launcher.includes("openBrowser(`${origin}/login`)"), false);
  assert.match(launcher, /openBrowser\(`\$\{origin\}\/settings`\)/);
  const login = fs.readFileSync(path.join(root, "app/src/routes/login.tsx"), "utf8");
  assert.match(login, /pageAfterSignIn/);
  assert.equal(login.includes('navigate({ to: "/" })'), false);
  const settings = fs.readFileSync(path.join(root, "app/src/routes/settings.tsx"), "utf8");
  assert.match(settings, /onThisPc \? null : \([\s\S]*Back to files/);
  const nsi = fs.readFileSync(path.join(root, "installer/drivebay.nsi"), "utf8");
  assert.match(nsi, /Open Drivebay settings/);
  assert.equal(nsi.includes("Open Drivebay in my browser"), false);
  assert.match(script, /\$script:SourceRef = "cursor\/windows-script-install-d803"/);
  const tree = script.slice(script.indexOf("function Get-DrivebayTree"), script.indexOf("function Install-PortableNode"));
  const checkout = tree.indexOf("installer\\launcher.mjs");
  const branchZip = tree.indexOf("archive/refs/heads/$ref.zip");
  const latest = tree.indexOf("Get-LatestRelease");
  assert.ok(checkout !== -1 && branchZip !== -1 && latest !== -1);
  assert.ok(checkout < branchZip && branchZip < latest);
  assert.match(tree, /if \(\$ref -ne "main"\)/);
  const index = fs.readFileSync(path.join(root, "app/src/routes/index.tsx"), "utf8");
  const guard = index.indexOf("beforeLoad");
  const browser = index.indexOf('import("@/components/browser/app")');
  assert.ok(guard !== -1 && browser !== -1 && guard < browser);
  assert.match(index, /redirect\(\{ to: "\/settings", replace: true \}\)/);
  for (const ch of nsi) {
    assert.ok(ch.charCodeAt(0) <= 127, `non-ASCII installer character ${JSON.stringify(ch)}`);
  }
});

test("setup-only writes a UTF-8 password and requires the router YES only for Regular", async () => {
  const ps = powershell();
  if (!ps) {
    if (process.platform === "win32") assert.fail("powershell is required on Windows");
    return;
  }
  const port = await freePort();
  assert.ok(port >= 1024 && port <= 65535);
  const password = ' p@ss"w\\ord$1 ';
  const script = path.join(root, "install.ps1");

  function run(extra) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-script-"));
    const result = spawnSync(ps, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        DRIVEBAY_SETUP_ONLY: "1",
        DRIVEBAY_SETUP_SOURCE: root,
        DRIVEBAY_SETUP_HOME: home,
        DRIVEBAY_SETUP_PORT: String(port),
        DRIVEBAY_SETUP_USER: "alice",
        DRIVEBAY_SKIP_START: "1",
        ...extra,
      },
    });
    return { home, result };
  }

  const regular = run({
    DRIVEBAY_SETUP_MODE: "regular",
    DRIVEBAY_SETUP_PASSWORD: password,
    DRIVEBAY_SETUP_ACK: "YES",
  });
  try {
    assert.equal(regular.result.status, 0, regular.result.stderr || regular.result.stdout);
    const pendingPath = path.join(regular.home, "pending-account.json");
    const bytes = fs.readFileSync(pendingPath);
    assert.equal(bytes[0], 0x7b);
    assert.notEqual(bytes[1], 0x00);
    const pending = JSON.parse(bytes.toString("utf8"));
    assert.equal(pending.username, "alice");
    assert.equal(pending.password, password);
    const config = JSON.parse(fs.readFileSync(path.join(regular.home, "config.json"), "utf8"));
    assert.equal(config.mode, "regular");
    assert.equal(config.port, port);
    const uninstall = fs.readFileSync(path.join(regular.home, "uninstall.ps1"), "utf8");
    assert.equal(uninstall.includes(password), false);
    assert.match(uninstall, /Type YES to also delete the saved password and settings/);
    assert.match(String(regular.result.stdout), /http:\/\/127\.0\.0\.1:\d+\/settings/);
    assert.match(String(regular.result.stdout), /open and forward TCP port/);
  } finally {
    fs.rmSync(regular.home, { recursive: true, force: true });
  }

  const tailscale = run({
    DRIVEBAY_SETUP_MODE: "tailscale",
    DRIVEBAY_SETUP_PASSWORD: password,
  });
  try {
    assert.equal(tailscale.result.status, 0, tailscale.result.stderr || tailscale.result.stdout);
    const config = JSON.parse(fs.readFileSync(path.join(tailscale.home, "config.json"), "utf8"));
    assert.equal(config.mode, "tailscale");
    const out = String(tailscale.result.stdout);
    assert.match(out, /You do not open that port on your router/);
    assert.equal(out.includes("Type YES to confirm"), false);
  } finally {
    fs.rmSync(tailscale.home, { recursive: true, force: true });
  }

  const denied = run({
    DRIVEBAY_SETUP_MODE: "regular",
    DRIVEBAY_SETUP_PASSWORD: password,
  });
  try {
    assert.equal(denied.result.status, 1);
    assert.match(String(denied.result.stderr), /Type YES to confirm/);
    assert.equal(fs.existsSync(path.join(denied.home, "pending-account.json")), false);
  } finally {
    fs.rmSync(denied.home, { recursive: true, force: true });
  }

  const short = run({
    DRIVEBAY_SETUP_MODE: "tailscale",
    DRIVEBAY_SETUP_PASSWORD: "short",
  });
  try {
    assert.equal(short.result.status, 1);
    assert.match(String(short.result.stderr), /at least 8 characters/);
    assert.equal(fs.existsSync(path.join(short.home, "pending-account.json")), false);
  } finally {
    fs.rmSync(short.home, { recursive: true, force: true });
  }
});
