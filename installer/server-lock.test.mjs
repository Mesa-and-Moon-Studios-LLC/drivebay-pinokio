import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isLoopbackAddress } from "../app/src/lib/files/loopback.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("only loopback addresses count as this PC", () => {
  for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "[::1]", "localhost", "127.1.2.3"]) {
    assert.equal(isLoopbackAddress(address), true, address);
  }
  for (const address of ["192.168.1.20", "100.64.0.2", "10.0.0.4", "172.16.0.2", "::ffff:192.168.1.20", "", null]) {
    assert.equal(isLoopbackAddress(address), false, String(address));
  }
});

test("server lock writes are loopback-only and the settings page can edit them", () => {
  const api = fs.readFileSync(path.join(root, "app/src/lib/files/api.functions.ts"), "utf8");
  const save = api.slice(api.indexOf("export const saveServerLock"));
  const restart = api.slice(api.indexOf("export const restartDrivebay"));
  assert.ok(save.indexOf("assertPcAdmin") !== -1);
  assert.ok(save.indexOf("assertPcAdmin") < save.indexOf("writeServerLock"));
  assert.ok(restart.indexOf("assertPcAdmin") !== -1);
  assert.ok(restart.indexOf("assertPcAdmin") < restart.indexOf("scheduleStandaloneRestart"));

  const lock = fs.readFileSync(path.join(root, "app/src/lib/files/server-lock.server.ts"), "utf8");
  assert.match(lock, /writeFileSync\(file, body, "utf8"\)/);
  assert.match(lock, /applied: samePolicy\(next, back\) \? "live" : "restart"/);
  const host = fs.readFileSync(path.join(root, "app/src/lib/files/host-request.server.ts"), "utf8");
  assert.equal(host.includes("x-forwarded-for"), false);
  assert.equal(host.includes("xForwardedFor"), false);

  const settings = fs.readFileSync(path.join(root, "app/src/routes/settings.tsx"), "utf8");
  assert.match(settings, /Save server lock/);
  assert.match(settings, /Restart Drivebay/);
  assert.match(settings, /Max upload \(MB\)/);
  assert.match(settings, /All drives/);
  assert.match(settings, /Choose drives/);
  assert.match(settings, /Add folder/);
  assert.match(settings, /canEditLock && serverLock/);
  const launcher = fs.readFileSync(path.join(root, "installer/launcher.mjs"), "utf8");
  assert.match(launcher, /DRIVEBAY_LAUNCHER: fileURLToPath\(import\.meta\.url\)/);
});
