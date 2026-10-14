/**
 * The 3.19 installer wrote the password with NSIS FileWrite, which is ANSI
 * even in a Unicode installer. write-setup.ps1 reads that file as UTF-16LE,
 * so the 8 ASCII bytes of "password" become 4 characters and the script exits 1.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const installerDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(installerDir, "..");

function writeUtf16(file, text) {
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]));
}

function readUtf16(file) {
  return fs.readFileSync(file).toString("utf16le").replace(/^\uFEFF/, "").replace(/\u0000+$/g, "").replace(/\r?\n$/, "");
}

function powershell() {
  for (const cmd of ["powershell.exe", "powershell", "pwsh"]) {
    const probe = spawnSync(cmd, ["-NoProfile", "-Command", "Write-Output ok"], { encoding: "utf8" });
    if (probe.status === 0 && String(probe.stdout).includes("ok")) return cmd;
  }
  return null;
}

test("ANSI FileWrite is the wrong width for the UTF-16 setup reader", () => {
  const misread = Buffer.from("password", "latin1").toString("utf16le").replace(/\u0000/g, "");
  assert.equal(misread.length, 4);
  assert.notEqual(misread, "password");

  const roundTrip = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from("password", "utf16le"),
  ])
    .toString("utf16le")
    .replace(/^\uFEFF/, "")
    .replace(/\u0000+$/g, "");
  assert.equal(roundTrip, "password");
});

test("installer writes UTF-16 files and starts the tray", () => {
  const src = fs.readFileSync(path.join(installerDir, "drivebay.nsi"), "utf8");
  assert.match(src, /FileWriteUTF16LE \/BOM/);
  assert.equal(/^\s*FileWrite\s/m.test(src), false);
  assert.equal(src.includes("SetEnvironmentVariable"), false);
  assert.equal(src.includes("System::Call"), false);
  assert.match(src, /write-setup\.ps1" -ParamsFile "\$TEMP\\drivebay-setup\.txt"/);
  assert.match(src, /\$SetupError/);
  assert.match(src, /FileReadUTF16LE \$R9 \$SetupError/);
  assert.match(
    src,
    /CreateShortCut "\$SMPROGRAMS\\Drivebay\\Drivebay\.lnk" "\$INSTDIR\\DrivebayTray\.exe"/,
  );
  assert.match(src, /CreateShortCut "\$DESKTOP\\Drivebay\.lnk" "\$INSTDIR\\DrivebayTray\.exe"/);
  assert.match(
    src,
    /WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "Drivebay" '"\$INSTDIR\\DrivebayTray\.exe" --background'/,
  );
  assert.match(src, /"\$INSTDIR\\DrivebayTray\.exe" --quit/);
  assert.match(src, /taskkill\.exe \/IM DrivebayTray\.exe \/F/);
  const execLine = src
    .split("\n")
    .find((line) => line.includes("write-setup.ps1"));
  assert.ok(execLine);
  assert.equal(execLine.includes("$Password"), false);
  assert.equal(execLine.includes("$Username"), false);

  const stage = fs.readFileSync(path.join(installerDir, "stage.mjs"), "utf8");
  assert.match(stage, /DrivebayTray\.exe/);
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/windows-installer.yml"), "utf8");
  assert.match(workflow, /csc\.exe/);
  assert.match(workflow, /setup-save\.test\.mjs/);
  assert.match(workflow, /\/target:winexe/);
  const ignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  assert.match(ignore, /installer\/DrivebayTray\.exe/);
});

test("tray source stays on C# 5 and exposes the menu", () => {
  const cs = fs.readFileSync(path.join(installerDir, "tray/DrivebayTray.cs"), "utf8");
  for (const ch of cs) {
    assert.ok(ch.charCodeAt(0) <= 127, `tray source has non-ASCII ${JSON.stringify(ch)}`);
  }
  assert.equal(cs.includes('$"'), false);
  assert.equal(cs.includes("nameof"), false);
  assert.equal(cs.includes("?."), false);
  assert.equal(cs.includes("=>"), false);
  assert.equal(cs.includes("out var"), false);
  for (const label of [
    "Open settings",
    "Copy address",
    "Start server",
    "Stop server",
    "Restart server",
    "Open logs folder",
    "Start with Windows",
    "Quit",
  ]) {
    assert.ok(cs.includes(`"${label}"`), label);
  }
  assert.match(cs, /Drivebay - running on port /);
  assert.match(cs, /Drivebay - server stopped unexpectedly/);
  assert.ok(cs.includes("Local\\\\DrivebayTray"));
  assert.match(cs, /--background/);
  assert.match(cs, /SystemIcons\.Warning/);
  assert.match(cs, /DRIVEBAY_NO_BROWSER/);
  assert.match(cs, /if \(stop \|\| quit\)/);
});

test("write-setup.ps1 saves a UTF-16 password and reports ANSI as too short", () => {
  const ps = powershell();
  if (!ps) {
    if (process.platform === "win32") assert.fail("powershell is required on Windows");
    return;
  }
  const script = path.join(installerDir, "windows/write-setup.ps1");
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-setup-"));
  const temp = path.join(rootDir, "temp");
  fs.mkdirSync(temp);

  function run(home, userFile, passFile) {
    const params = path.join(temp, `params-${path.basename(home)}.txt`);
    writeUtf16(params, `${home}\r\n42013\r\nregular\r\n3.19\r\n${userFile}\r\n${passFile}\r\n`);
    const result = spawnSync(
      ps,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-ParamsFile", params],
      { encoding: "utf8", env: { ...process.env, TEMP: temp, TMP: temp } },
    );
    const resultFile = path.join(temp, "drivebay-setup-result.txt");
    const text = fs.existsSync(resultFile) ? readUtf16(resultFile) : "";
    return { status: result.status, text, stderr: result.stderr };
  }

  try {
    const home = path.join(rootDir, "Drivebay Home");
    const userFile = path.join(temp, "user.txt");
    const passFile = path.join(temp, "pass.txt");
    const password = ' p@ss"w\\ord$1 ';
    writeUtf16(userFile, "alice");
    writeUtf16(passFile, password);
    const saved = run(home, userFile, passFile);
    assert.equal(saved.status, 0, saved.stderr || saved.text);
    assert.match(saved.text, /^OK /);
    assert.equal(saved.text.includes(password), false);
    assert.equal(fs.existsSync(userFile), false);
    assert.equal(fs.existsSync(passFile), false);
    const pending = JSON.parse(fs.readFileSync(path.join(home, "pending-account.json"), "utf8"));
    assert.equal(pending.username, "alice");
    assert.equal(pending.password, password);
    const config = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
    assert.equal(config.port, 42013);
    assert.equal(config.mode, "regular");
    const log = fs.readFileSync(path.join(home, "setup.log"), "utf8");
    assert.equal(log.includes(password), false);

    const badHome = path.join(rootDir, "missing-pass");
    const badUser = path.join(temp, "bad-user.txt");
    writeUtf16(badUser, "alice");
    const missing = run(badHome, badUser, path.join(temp, "no-such-pass.txt"));
    assert.equal(missing.status, 1);
    assert.match(missing.text, /^ERROR: /);
    assert.equal(fs.existsSync(path.join(badHome, "config.json")), true);
    assert.equal(fs.existsSync(path.join(badHome, "pending-account.json")), false);

    const ansiHome = path.join(rootDir, "ansi-pass");
    const ansiUser = path.join(temp, "ansi-user.txt");
    const ansiPass = path.join(temp, "ansi-pass.txt");
    writeUtf16(ansiUser, "alice");
    fs.writeFileSync(ansiPass, Buffer.from("password", "latin1"));
    const ansi = run(ansiHome, ansiUser, ansiPass);
    assert.equal(ansi.status, 1);
    assert.match(ansi.text, /^ERROR: Password must be at least 8 characters/);
    assert.equal(fs.existsSync(path.join(ansiHome, "config.json")), true);
    assert.equal(fs.existsSync(path.join(ansiHome, "pending-account.json")), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
