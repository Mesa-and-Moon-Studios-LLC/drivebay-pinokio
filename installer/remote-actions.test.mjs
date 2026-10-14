import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isAndroidUserAgent, settingsOnThisPc } from "../app/src/lib/files/client-surface.mjs";
import {
  browserActionsFor,
  defaultRemoteActions,
  readRemoteActionsFile,
  remoteActionAllowed,
  remoteDeniedMessage,
  writeRemoteActionsFile,
} from "../app/src/lib/files/remote-actions.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lock = {
  allowDelete: true,
  allowRename: true,
  allowCreateFolder: true,
  allowUpload: true,
  maxUploadMb: 512,
};

test("other-device actions default to on and a missing file stays on", () => {
  assert.deepEqual(defaultRemoteActions(), {
    allowDeleteFromOtherDevices: true,
    allowUploadRenameFromOtherDevices: true,
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-remote-"));
  const file = path.join(dir, "remote-actions.json");
  try {
    assert.deepEqual(readRemoteActionsFile(file), defaultRemoteActions());
    writeRemoteActionsFile(file, { allowDeleteFromOtherDevices: false, allowUploadRenameFromOtherDevices: true });
    assert.equal(readRemoteActionsFile(file).allowDeleteFromOtherDevices, false);
    assert.equal(readRemoteActionsFile(file).allowUploadRenameFromOtherDevices, true);
    writeRemoteActionsFile(file, {});
    assert.deepEqual(readRemoteActionsFile(file), defaultRemoteActions());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("this PC can always delete, upload, and rename, and other devices follow the switches", () => {
  const off = { allowDeleteFromOtherDevices: false, allowUploadRenameFromOtherDevices: false };
  const on = defaultRemoteActions();
  for (const action of ["delete", "upload", "rename", "move"]) {
    assert.equal(remoteActionAllowed(off, action, true), true, action);
    assert.equal(remoteActionAllowed(on, action, false), true, action);
  }
  assert.equal(remoteActionAllowed(off, "delete", false), false);
  assert.equal(remoteActionAllowed(off, "upload", false), false);
  assert.equal(remoteActionAllowed(off, "rename", false), false);
  assert.equal(remoteActionAllowed(off, "move", false), false);
  assert.equal(remoteActionAllowed({ allowDeleteFromOtherDevices: false, allowUploadRenameFromOtherDevices: true }, "delete", false), false);
  assert.equal(remoteActionAllowed({ allowDeleteFromOtherDevices: false, allowUploadRenameFromOtherDevices: true }, "upload", false), true);
  assert.equal(remoteDeniedMessage("delete").includes("Delete"), true);
  assert.equal(remoteDeniedMessage("rename").includes("Upload"), true);

  const hidden = browserActionsFor(lock, off, false);
  assert.equal(hidden.allowDelete, false);
  assert.equal(hidden.allowUpload, false);
  assert.equal(hidden.allowRename, false);
  assert.equal(hidden.allowMove, false);
  assert.equal(hidden.allowCreateFolder, true);
  const shown = browserActionsFor(lock, off, true);
  assert.equal(shown.allowDelete, true);
  assert.equal(shown.allowUpload, true);
  assert.equal(shown.allowMove, true);
  const locked = browserActionsFor({ ...lock, allowDelete: false, allowUpload: false }, on, true);
  assert.equal(locked.allowDelete, false);
  assert.equal(locked.allowUpload, false);
});

test("server settings are recognized only on this PC, not in the Android app", () => {
  assert.equal(isAndroidUserAgent("Mozilla/5.0 DriveBayAndroid/3.33.0"), true);
  assert.equal(isAndroidUserAgent("Mozilla/5.0"), false);
  assert.equal(settingsOnThisPc("127.0.0.1"), true);
  assert.equal(settingsOnThisPc("100.80.1.2"), false);
  assert.equal(settingsOnThisPc("192.168.1.20"), false);
});

test("admin routes, remote actions, and the Android app stay on the right side", () => {
  const api = fs.readFileSync(path.join(root, "app/src/lib/files/api.functions.ts"), "utf8");
  for (const name of [
    "getSettings",
    "saveDriveAccess",
    "savePortSettings",
    "saveServerLock",
    "savePublicAccess",
    "restartDrivebay",
    "getApiAccess",
    "createApiToken",
    "revokeApiToken",
    "allowApiWrite",
    "decideApiApproval",
    "saveRemoteActions",
    "getRouterHelp",
  ]) {
    const start = api.indexOf(`export const ${name}`);
    assert.ok(start !== -1, name);
    const next = api.indexOf("export const ", start + 10);
    const body = api.slice(start, next === -1 ? undefined : next);
    assert.match(body, /assertPcAdmin/, name);
  }
  const browserActions = api.slice(api.indexOf("export const getBrowserActions"), api.indexOf("export const saveRemoteActions"));
  assert.equal(browserActions.includes("assertPcAdmin"), false);
  assert.match(api, /assertRemoteAction\("delete"\)/);
  assert.match(api, /assertRemoteAction\("upload"\)/);
  assert.match(api, /assertRemoteAction\("rename"\)/);

  const host = fs.readFileSync(path.join(root, "app/src/lib/files/host-request.server.ts"), "utf8");
  assert.match(host, /status: 403/);
  assert.match(host, /isLoopbackRequest\(\) && !isAndroidAppRequest\(\)/);
  assert.equal(host.includes("x-forwarded-for"), false);

  const remote = fs.readFileSync(path.join(root, "app/src/lib/files/remote-actions.server.ts"), "utf8");
  assert.match(remote, /status: 403/);
  const v1 = fs.readFileSync(path.join(root, "app/src/lib/files/api-v1.server.ts"), "utf8");
  assert.match(v1, /assertRemoteAction/);
  const auth = fs.readFileSync(path.join(root, "app/src/routes/api/auth/$.ts"), "utf8");
  assert.match(auth, /change-password/);
  assert.match(auth, /status: 403/);

  const settings = fs.readFileSync(path.join(root, "app/src/routes/settings.tsx"), "utf8");
  assert.match(settings, /Allow delete from other devices/);
  assert.match(settings, /Allow upload\/rename from other devices/);
  assert.match(settings, /Server settings stay on this PC/);
  const phone = settings.indexOf("Server settings stay on this PC");
  const admin = settings.indexOf("Allow delete from other devices");
  const gate = settings.indexOf("{onThisPc ? (");
  assert.ok(gate !== -1 && admin > gate && phone > admin);

  const browser = fs.readFileSync(path.join(root, "app/src/components/browser/app.tsx"), "utf8");
  assert.match(browser, /getBrowserActions/);
  assert.equal(browser.includes("getSettings"), false);
  assert.match(browser, /serverLock\?\.allowUpload \?/);
  assert.match(browser, /serverLock\?\.allowDelete \?/);
  assert.match(browser, /openAppSettings/);
  assert.match(browser, /App settings/);

  const main = fs.readFileSync(path.join(root, "android/app/src/main/java/com/lordstryfe/drivebay/MainActivity.kt"), "utf8");
  assert.match(main, /isAdminSettingsUrl/);
  assert.match(main, /fun openAppSettings/);
  const strings = fs.readFileSync(path.join(root, "android/app/src/main/res/values/strings.xml"), "utf8");
  assert.match(strings, /App settings/);
  assert.match(strings, /Server settings stay on the PC/);
});
