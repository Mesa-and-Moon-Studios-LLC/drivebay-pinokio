import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  hashPassword,
  resetCredentialPassword,
  verifyPassword,
} from "../app/src/lib/auth/reset-password.mjs";
import { assertLocalReset, openDrivebayDatabase, runResetCommand } from "./reset-password.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migration = fs.readFileSync(path.join(root, "app/migrations/0001_auth.sql"), "utf8");
const password = "new-password-1";

function capture() {
  let text = "";
  const stream = new Writable({
    write(chunk, _enc, callback) {
      text += Buffer.from(chunk).toString("utf8");
      callback();
    },
  });
  return { stream, read: () => text };
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

test("credential hash matches Better Auth and does not store the password", async () => {
  const hash = await hashPassword(password);
  assert.equal(hash.includes(password), false);
  assert.match(hash, /^[0-9a-f]{32}:[0-9a-f]{128}$/);
  assert.equal(await verifyPassword(hash, password), true);
  assert.equal(await verifyPassword(hash, "other-password"), false);
  const again = await hashPassword(password);
  assert.notEqual(hash, again);
  assert.equal(await verifyPassword(again, password), true);
});

test("a password argument or environment variable is refused", () => {
  assert.throws(() => assertLocalReset(["reset-password", password], {}), /does not take it as an argument/);
  assert.throws(() => assertLocalReset(["reset-password", "--password", password], {}), /does not take it as an argument/);
  assert.throws(
    () => assertLocalReset(["reset-password"], { DRIVEBAY_NEW_PASSWORD: password }),
    /does not take it from the environment/,
  );
  assert.throws(
    () => assertLocalReset(["reset-password", "--stdin"], { DATABASE_URL: "postgres://db.example/app" }),
    /only changes the account database on this PC/,
  );
  assert.doesNotThrow(() => assertLocalReset(["reset-password", "--stdin"], {}));
});

test("local reset updates the credential hash, revokes sessions, and keeps settings", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-reset-"));
  const dataDir = path.join(home, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const config = '{"port":8765,"mode":"tailscale"}\n';
  const tokens = '{"tokens":[{"id":"tok","hash":"abc","name":"phone"}]}\n';
  fs.writeFileSync(path.join(home, "config.json"), config);
  fs.writeFileSync(path.join(home, "api-tokens.json"), tokens);
  fs.writeFileSync(path.join(home, "pending-account.json"), '{"username":"aaron","password":"old-password-1"}\n');
  fs.writeFileSync(path.join(home, "auth.secret"), "old-secret-value-0123456789abcdef\n");
  const oldHash = await hashPassword("old-password-1");
  const db = await openDrivebayDatabase(dataDir);
  await db.exec(migration);
  await db.query(
    `insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt") values ('user-1','aaron','aaron@drivebay.local', true, now(), now())`,
  );
  await db.query(
    `insert into "account" ("id","accountId","providerId","userId","password","createdAt","updatedAt") values ('acct-1','user-1','credential','user-1',$1, now(), now())`,
    [oldHash],
  );
  await db.query(
    `insert into "account" ("id","accountId","providerId","userId","password","createdAt","updatedAt") values ('acct-oauth','aaron','grok-google','user-1', null, now(), now())`,
  );
  await db.query(
    `insert into "session" ("id","expiresAt","token","createdAt","updatedAt","userId") values ('sess-1', now() + interval '7 days', 'session-token', now(), now(), 'user-1')`,
  );
  await db.query(`create table kept_settings (note text)`);
  await db.query(`insert into kept_settings (note) values ('drives-stay')`);
  await db.close();

  const logs = [];
  const err = capture();
  const code = await runResetCommand({
    home,
    argv: ["reset-password", "--stdin"],
    env: {},
    stdin: Readable.from([Buffer.from(`${password}\n`)]),
    stderr: err.stream,
    wasRunning: false,
    serverEntry: null,
    stop: async () => {},
    log: (message) => {
      logs.push(message);
      fs.appendFileSync(path.join(home, "drivebay.log"), `${message}\n`);
    },
    rotateSecret: () => {
      fs.writeFileSync(path.join(home, "auth.secret"), `${crypto.randomBytes(32).toString("hex")}\n`);
    },
    shredPending: () => {
      const file = path.join(home, "pending-account.json");
      fs.writeFileSync(file, Buffer.alloc(64));
      fs.rmSync(file, { force: true });
    },
    startAgain: () => {
      throw new Error("should not start");
    },
  });
  assert.equal(code, 0, err.read());
  assert.match(err.read(), /Password updated for aaron/);
  assert.equal(err.read().includes(password), false);
  assert.equal(logs.join("\n").includes(password), false);
  assert.equal(fs.existsSync(path.join(home, "pending-account.json")), false);
  assert.equal(fs.readFileSync(path.join(home, "config.json"), "utf8"), config);
  assert.equal(fs.readFileSync(path.join(home, "api-tokens.json"), "utf8"), tokens);
  assert.notEqual(fs.readFileSync(path.join(home, "auth.secret"), "utf8").trim(), "old-secret-value-0123456789abcdef");

  const after = await openDrivebayDatabase(dataDir);
  const accounts = await after.query(
    `select "providerId", "password" from "account" order by "id"`,
  );
  const credential = accounts.find((row) => row.providerId === "credential");
  const oauth = accounts.find((row) => row.providerId === "grok-google");
  assert.equal(await verifyPassword(credential.password, password), true);
  assert.equal(await verifyPassword(credential.password, "old-password-1"), false);
  assert.equal(credential.password.includes(password), false);
  assert.equal(oauth.password, null);
  const sessions = await after.query(`select count(*)::int as n from "session"`);
  assert.equal(Number(sessions[0].n), 0);
  const users = await after.query(`select "name" from "user"`);
  assert.equal(users[0].name, "aaron");
  const kept = await after.query(`select note from kept_settings`);
  assert.equal(kept[0].note, "drives-stay");
  await after.close();

  const leaked = walk(home).filter((file) => fs.readFileSync(file).includes(Buffer.from(password)));
  assert.deepEqual(leaked, []);
});

test("reset refuses to run when no local account exists", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-reset-empty-"));
  const err = capture();
  const code = await runResetCommand({
    home,
    argv: ["reset-password", "--stdin"],
    env: {},
    stdin: Readable.from([Buffer.from(`${password}\n`)]),
    stderr: err.stream,
    serverEntry: null,
  });
  assert.equal(code, 1);
  assert.match(err.read(), /No Drivebay account is saved on this PC/);
  assert.equal(err.read().includes(password), false);
});

test("the login page explains the tray reset and does not offer a remote one", () => {
  const login = fs.readFileSync(path.join(root, "app/src/routes/login.tsx"), "utf8");
  assert.match(login, /Forgot password\?/);
  assert.match(login, /Reset password/);
  assert.match(login, /notification area/);
  assert.match(login, /cannot\s+be reset from a phone/);
  assert.equal(login.includes("/api/reset"), false);
  assert.equal(login.includes("resetCredentialPassword"), false);
  const routes = walk(path.join(root, "app/src/routes")).map((file) => path.basename(file));
  assert.equal(routes.some((name) => /reset/i.test(name)), false);
  const plugin = fs.readFileSync(path.join(root, "app/server/plugins/reset-password.ts"), "utf8");
  assert.match(plugin, /DRIVEBAY_RESET_PASSWORD !== "1"/);
  assert.equal(plugin.includes("defineEventHandler"), false);
  assert.equal(plugin.includes(".use("), false);
});

test("the tray and PowerShell command stay on this PC and do not print the password", () => {
  const tray = fs.readFileSync(path.join(root, "installer/tray/DrivebayTray.cs"), "utf8");
  assert.match(tray, /"Reset password"/);
  assert.match(tray, /PasswordChar = '\*'/);
  assert.match(tray, /reset-password --stdin/);
  assert.equal(tray.includes("=>"), false);
  assert.equal(tray.includes("Log(first"), false);
  const ps1 = fs.readFileSync(path.join(root, "reset-password.ps1"), "utf8");
  assert.match(ps1, /Read-Host -AsSecureString "New password"/);
  assert.match(ps1, /Read-Host -AsSecureString "Type it again"/);
  assert.match(ps1, /reset-password --stdin/);
  assert.equal(ps1.includes("Write-Host $typed"), false);
  assert.equal(ps1.includes("Write-Host $again"), false);
  assert.match(ps1, /does not take it as an argument/);
  const launcher = fs.readFileSync(path.join(root, "installer/launcher.mjs"), "utf8");
  assert.match(launcher, /process\.argv\[2\] === "reset-password"/);
  assert.match(launcher, /rotateAuthSecret/);
  const cmd = fs.readFileSync(path.join(root, "installer/drivebay.cmd"), "utf8");
  assert.match(cmd, /launcher\.mjs/);
});

test("direct SQL reset leaves non-credential rows alone", async () => {
  const calls = [];
  const sql = {
    async query(text, params = []) {
      calls.push({ text, params });
      if (text.includes('providerId" = \'credential\'')) {
        return [{ id: "acct-1", userId: "user-1", name: "aaron", email: "aaron@drivebay.local" }];
      }
      return [];
    },
  };
  const result = await resetCredentialPassword(sql, password);
  assert.equal(result.ok, true);
  assert.equal(result.username, "aaron");
  const update = calls.find((call) => call.text.startsWith("update"));
  assert.equal(update.params[1], "acct-1");
  assert.equal(String(update.params[0]).includes(password), false);
  assert.equal(await verifyPassword(update.params[0], password), true);
  assert.ok(calls.some((call) => call.text.startsWith("delete from \"session\"")));
  assert.equal(calls.some((call) => /drop table|delete from "user"|api_token|config/i.test(call.text)), false);
});
