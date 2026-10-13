import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  firstRunMode,
  loadPendingAccount,
  parsePendingAccount,
  pendingAccountPath,
} from "../app/src/lib/auth/pending-account.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const win = path.win32;
const account = "pending-account.json";
const exeHome = "C:\\Users\\Ada\\AppData\\Local\\Drivebay";
const exeFile = `${exeHome}\\${account}`;

test("script, exe, and server read the same account file", () => {
  assert.equal(pendingAccountPath({ DRIVEBAY_HOME: exeHome }, win), exeFile);
  assert.equal(
    pendingAccountPath({ DRIVEBAY_DATA_DIR: `${exeHome}\\data` }, win),
    exeFile,
  );
  assert.equal(
    pendingAccountPath({ LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" }, win),
    exeFile,
  );
  assert.equal(
    pendingAccountPath(
      {
        DRIVEBAY_HOME: exeHome,
        DRIVEBAY_DATA_DIR: `${exeHome}\\data`,
        LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local",
      },
      win,
    ),
    exeFile,
  );

  const pinokioFile = pendingAccountPath(
    {
      DRIVEBAY_PINOKIO: "true",
      DRIVEBAY_DATA_DIR: "C:\\pinokio\\drivebay\\data",
      LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local",
    },
    win,
  );
  assert.equal(pinokioFile, "C:\\pinokio\\drivebay\\pending-account.json");
  assert.notEqual(pinokioFile, exeFile);
  assert.equal(
    pendingAccountPath(
      { DRIVEBAY_PINOKIO: "true", DRIVEBAY_CWD: "C:\\pinokio\\drivebay\\app" },
      win,
    ),
    "C:\\pinokio\\drivebay\\pending-account.json",
  );
});

test("a setup account unlocks, and a missing account still creates", () => {
  assert.equal(firstRunMode({ userCount: 0, pending: null }), "create");
  assert.equal(firstRunMode({ userCount: 0, pending: { ok: false } }), "create");
  assert.equal(firstRunMode({ userCount: 0, pending: { ok: true } }), "unlock");
  assert.equal(firstRunMode({ userCount: 1, pending: null }), "unlock");

  const password = ' p@ss"w\\ord$1 ';
  const text = JSON.stringify({ username: " ada ", password });
  const parsed = parsePendingAccount(`\uFEFF${text}`);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.username, "ada");
    assert.equal(parsed.password, password);
  }
  const utf16 = Buffer.from(text, "utf16le").toString("utf8");
  assert.equal(parsePendingAccount(utf16).ok, false);
  assert.equal(parsePendingAccount('{"username":"ada","password":"short"}').ok, false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-pending-"));
  const file = path.join(dir, account);
  assert.equal(loadPendingAccount(file), null);
  fs.writeFileSync(file, text, "utf8");
  const loaded = loadPendingAccount(file);
  assert.equal(loaded?.ok, true);
  if (loaded?.ok) assert.equal(loaded.password, password);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("every Windows install path names the same account file", () => {
  const writeSetup = fs.readFileSync(path.join(root, "installer/windows/write-setup.ps1"), "utf8");
  assert.match(writeSetup, /Join-Path \$homeDir "pending-account\.json"/);
  assert.equal(writeSetup.includes('Join-Path $homeDir "data\\pending-account.json"'), false);
  assert.match(writeSetup, /UTF8Encoding \$false/);

  const nsi = fs.readFileSync(path.join(root, "installer/drivebay.nsi"), "utf8");
  assert.match(
    nsi,
    /FileWriteUTF16LE \/BOM \$R9 "\$LOCALAPPDATA\\Drivebay\$\\r\$\\n\$Port/,
  );
  assert.match(nsi, /\$LOCALAPPDATA\\Drivebay\\pending-account\.json/);

  const script = fs.readFileSync(path.join(root, "install.ps1"), "utf8");
  assert.match(script, /\$root = Join-Path \$env:LOCALAPPDATA "Drivebay"/);
  assert.match(script, /\$body = \$Root \+ "`r`n"/);
  assert.match(script, /Join-Path \$Root "pending-account\.json"/);

  const launcher = fs.readFileSync(path.join(root, "installer/launcher.mjs"), "utf8");
  assert.match(launcher, /path\.join\(home, "pending-account\.json"\)/);
  assert.match(launcher, /DRIVEBAY_HOME: home/);
  assert.match(launcher, /DRIVEBAY_DATA_DIR: path\.join\(home, "data"\)/);

  const runDev = fs.readFileSync(path.join(root, "run-dev.cjs"), "utf8");
  assert.equal(runDev.includes("pending-account"), false);
  assert.match(runDev, /DRIVEBAY_DATA_DIR: path\.join\(__dirname, "data"\)/);

  const login = fs.readFileSync(path.join(root, "app/src/routes/login.tsx"), "utf8");
  assert.match(login, /value\.owned/);
  assert.match(login, /value\.username/);
  assert.match(login, /owned \? "Unlock this machine" : "Set the lock"/);
  const api = fs.readFileSync(path.join(root, "app/src/lib/files/api.functions.ts"), "utf8");
  assert.match(api, /accountFirstRun/);
  const authRoute = fs.readFileSync(path.join(root, "app/src/routes/api/auth/$.ts"), "utf8");
  const post = authRoute.slice(authRoute.indexOf("POST:"));
  const applyAt = post.indexOf("applyPendingAccount");
  const closedAt = post.indexOf("sign-up");
  assert.ok(applyAt !== -1 && closedAt !== -1 && applyAt < closedAt);
});
