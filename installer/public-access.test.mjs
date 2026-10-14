import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { publicAccessOffHtml } from "../app/src/lib/files/document-request.mjs";
import {
  nextPublicAccess,
  publicAccessOpen,
  readPublicAccessFile,
  requestReach,
  writePublicAccessFile,
} from "../app/src/lib/files/public-access.mjs";
import { isTailnetAddress } from "../app/src/lib/files/tailnet.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("tailnet ranges are 100.64.0.0/10 and fd7a:115c:a1e0::/48", () => {
  for (const address of ["100.64.0.1", "100.127.255.255", "::ffff:100.80.1.2", "[fd7a:115c:a1e0::35]", "fd7a:115c:a1e0::1%tailscale0"]) {
    assert.equal(isTailnetAddress(address), true, address);
  }
  for (const address of ["100.63.255.255", "100.128.0.1", "192.168.1.20", "127.0.0.1", "fd7a:115c:a1e1::1", "fd7a:115d:a1e0::1", "", null]) {
    assert.equal(isTailnetAddress(address), false, String(address));
  }
});

test("Both mode refuses public addresses until public access is on", () => {
  const now = 1_700_000_000_000;
  const off = { enabled: false, offAt: null };
  const on = { enabled: true, offAt: null };
  assert.equal(requestReach("both", "192.168.1.20", off, now), "deny");
  assert.equal(requestReach("both", "8.8.8.8", off, now), "deny");
  assert.equal(requestReach("both", "127.0.0.1", off, now), "allow");
  assert.equal(requestReach("both", "100.80.180.121", off, now), "allow");
  assert.equal(requestReach("both", "fd7a:115c:a1e0::8", off, now), "allow");
  assert.equal(requestReach("both", "192.168.1.20", on, now), "allow");
  assert.equal(requestReach("tailscale", "192.168.1.20", off, now), "allow");
  assert.equal(requestReach("regular", "8.8.8.8", off, now), "allow");
  assert.equal(publicAccessOpen(true, now + 1000, now), true);
  assert.equal(publicAccessOpen(true, now, now), false);
  assert.equal(requestReach("both", "8.8.8.8", { enabled: true, offAt: now }, now), "deny");
});

test("the auto-off timer is 1, 4, or 24 hours and a missing file stays off", () => {
  const now = 1_700_000_000_000;
  assert.deepEqual(nextPublicAccess(true, 1, now), { enabled: true, offAt: now + 60 * 60 * 1000 });
  assert.deepEqual(nextPublicAccess(true, 4, now), { enabled: true, offAt: now + 4 * 60 * 60 * 1000 });
  assert.deepEqual(nextPublicAccess(true, 24, now), { enabled: true, offAt: now + 24 * 60 * 60 * 1000 });
  assert.deepEqual(nextPublicAccess(true, 0, now), { enabled: true, offAt: null });
  assert.deepEqual(nextPublicAccess(false, 4, now), { enabled: false, offAt: null });
  assert.throws(() => nextPublicAccess(true, 2, now), /1 hour, 4 hours, 24 hours/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-public-"));
  const file = path.join(dir, "public-access.json");
  try {
    assert.deepEqual(readPublicAccessFile(file, now), { enabled: false, offAt: null });
    writePublicAccessFile(file, nextPublicAccess(true, 1, now));
    assert.deepEqual(readPublicAccessFile(file, now + 1000), { enabled: true, offAt: now + 60 * 60 * 1000 });
    const expired = readPublicAccessFile(file, now + 60 * 60 * 1000);
    assert.deepEqual(expired, { enabled: false, offAt: null });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { enabled: false, offAt: null });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a browser refusal page has no sign-in form, and the toggle is not a server lock", () => {
  const html = publicAccessOffHtml();
  assert.match(html, /Public access is off/);
  assert.match(html, /did not open a sign-in page/);
  assert.equal(html.includes("<form"), false);
  assert.equal(html.toLowerCase().includes("password"), false);
  assert.equal(html.includes("Sign in"), false);

  const start = fs.readFileSync(path.join(root, "app/src/start.ts"), "utf8");
  const mw = start.slice(start.indexOf("const documentMiddleware"), start.indexOf("const csrfMiddleware"));
  assert.ok(mw.indexOf("publicAccessBlock") !== -1);
  assert.ok(mw.indexOf("publicAccessBlock") < mw.indexOf('handlerType === "serverFn"'));

  const api = fs.readFileSync(path.join(root, "app/src/lib/files/api.functions.ts"), "utf8");
  const pub = api.slice(api.indexOf("export const savePublicAccess"), api.indexOf("export const restartDrivebay"));
  assert.match(pub, /assertPcAdmin/);
  assert.equal(pub.includes("assertPublicAccessEditor"), false);
  const lock = api.slice(api.indexOf("export const saveServerLock"), api.indexOf("export const savePublicAccess"));
  assert.match(lock, /assertPcAdmin/);
  assert.equal(lock.includes("assertPublicAccessEditor"), false);

  const settings = fs.readFileSync(path.join(root, "app/src/routes/settings.tsx"), "utf8");
  assert.match(settings, /Public access: \{publicAccess\.enabled \? "On" : "Off"\}/);
  assert.match(settings, /Turn public access on/);
  assert.match(settings, /1 hour/);
  assert.match(settings, /4 hours/);
  assert.match(settings, /24 hours/);
  assert.match(settings, /reachMode === "regular" \|\| reachMode === "both"/);
});
