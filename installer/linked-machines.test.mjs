import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isSpaDocument } from "../app/src/lib/files/document-request.mjs";
import { handleDav } from "../app/src/lib/files/linked-dav.mjs";
import {
  approveLocalRequest,
  handleLinkedHttp,
  issueLocalCode,
} from "../app/src/lib/files/linked-http.mjs";
import {
  CLOUD_KEYS,
  DIRECT_INTERNET_WARNING,
  classifyAddresses,
  connectionUrl,
  freshPairState,
  isOnline,
  approveRequest,
  issueCode,
  linkedMountPlan,
  normalizeShares,
  pickDriveLetter,
  pollRequest,
  randomRequestId,
  redeemCode,
  sanitizeRegistration,
  startRequest,
  verifyPairToken,
  visibleMachines,
} from "../app/src/lib/files/linked-machines.mjs";
import { appleAuthorizeUrl, googleAuthorizeUrl, idpPostBody, readIdTokenFragment } from "../app/src/lib/files/mesa-signin.mjs";
import { loadPairState, saveShares, writePrivate } from "../app/src/lib/files/linked-store.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const base = {
  machineId: "machine-office-1",
  displayName: "Office",
  type: "pc",
  tailscaleHost: "100.64.0.8",
  lanAddress: "192.168.1.20",
  port: 8765,
  publicKey: "A".repeat(40),
  lastSeen: new Date().toISOString(),
  hidden: false,
  directInternet: false,
  publicHost: "",
};

test("cloud records reject anything that is not connection info", () => {
  const clean = sanitizeRegistration(base);
  assert.equal(clean.ok, true);
  assert.deepEqual(Object.keys(clean.machine).sort(), [...CLOUD_KEYS].sort());
  for (const extra of ["password", "token", "phoneCode", "folders", "files", "refreshToken", "privateKey"]) {
    const refused = sanitizeRegistration({ ...base, [extra]: "nope" });
    assert.equal(refused.ok, false, extra);
  }
  assert.equal(sanitizeRegistration({ ...base, directInternet: false, publicHost: "203.0.113.5" }).machine.publicHost, "");
  assert.equal(sanitizeRegistration({ ...base, directInternet: true, publicHost: "203.0.113.5" }).machine.publicHost, "203.0.113.5");
});

test("hidden machines stay off other machines' lists", () => {
  const hidden = { ...base, machineId: "machine-hidden-1", hidden: true, displayName: "Secret" };
  const visible = visibleMachines([base, hidden], base.machineId);
  assert.deepEqual(visible.map((row) => row.machineId), [base.machineId]);
  const self = visibleMachines([hidden], hidden.machineId);
  assert.equal(self.length, 1);
});

test("connection prefers Tailscale and warns before the public internet", () => {
  assert.equal(connectionUrl(base).via, "tailscale");
  assert.equal(connectionUrl(base).url, "http://100.64.0.8:8765/dav/");
  const lanOnly = connectionUrl({ ...base, tailscaleHost: "" });
  assert.equal(lanOnly.via, "lan");
  const closed = connectionUrl({ ...base, tailscaleHost: "", lanAddress: "", publicHost: "203.0.113.5" });
  assert.equal(closed.url, "");
  const opened = connectionUrl({
    ...base,
    tailscaleHost: "",
    lanAddress: "",
    directInternet: true,
    publicHost: "203.0.113.5",
  });
  assert.equal(opened.via, "public");
  assert.equal(opened.risk, true);
  assert.match(DIRECT_INTERNET_WARNING, /less safe than Tailscale/);
  assert.equal(connectionUrl({ ...base, type: "phone" }).url, "http://100.64.0.8:8765/");
});

test("online is last seen within two minutes", () => {
  const now = Date.parse("2026-10-22T12:00:00Z");
  assert.equal(isOnline(new Date(now - 30_000).toISOString(), now), true);
  assert.equal(isOnline(new Date(now - 180_000).toISOString(), now), false);
});

test("addresses pick Tailscale and LAN separately", () => {
  const found = classifyAddresses(["192.168.1.9", "100.70.1.2", "8.8.8.8", "172.16.0.4"]);
  assert.equal(found.tailscaleHost, "100.70.1.2");
  assert.equal(found.lanAddress, "192.168.1.9");
});

test("a code is stored as a hash and a token is kept for the pair", () => {
  let state = freshPairState();
  state = issueCode(state, { code: "123456", salt: "salt-1", now: 1_000 });
  assert.equal(JSON.stringify(state).includes("123456"), false);
  const bad = redeemCode(state, {
    code: "000000",
    peerId: "machine-other-1",
    name: "Laptop",
    now: 2_000,
    token: "dbp_token",
    tokenSalt: "salt-2",
  });
  assert.equal(bad.ok, false);
  const good = redeemCode(state, {
    code: "123456",
    peerId: "machine-other-1",
    name: "Laptop",
    now: 2_000,
    token: "dbp_token",
    tokenSalt: "salt-2",
  });
  assert.equal(good.ok, true);
  assert.equal(good.state.code, null);
  assert.equal(verifyPairToken(good.state, "dbp_token"), true);
  assert.equal(verifyPairToken(good.state, "dbp_other"), false);
  assert.equal(JSON.stringify(good.state).includes("dbp_token"), false);
});

test("each machine keeps its own drive letter and a request id fits the pair record", () => {
  const first = pickDriveLetter({}, "machine-a", "P");
  assert.equal(first, "P");
  const second = pickDriveLetter({ "machine-a": { letter: "P" } }, "machine-b", "P");
  assert.equal(second, "Q");
  const kept = pickDriveLetter({ "machine-a": { letter: "P" } }, "machine-a", "P");
  assert.equal(kept, "P");
  assert.equal(pickDriveLetter({}, "machine-a", "C"), "P");
  const id = randomRequestId();
  assert.match(id, /^[a-f0-9]{32}$/);
});

test("approval returns the pair token only to the machine that asked", () => {
  let state = startRequest(freshPairState(), {
    id: "req-1",
    fromId: "machine-other-1",
    name: "Laptop",
    secret: "request-secret-value",
    salt: "salt-r",
    now: 5_000,
  });
  const approved = approveRequest(state, "req-1", { token: "dbp_approved", tokenSalt: "salt-t", now: 6_000 });
  assert.equal(approved.ok, true);
  const stranger = pollRequest(approved.state, { id: "req-1", secret: "wrong-secret-value" });
  assert.equal(stranger.ok, false);
  const owner = pollRequest(approved.state, { id: "req-1", secret: "request-secret-value" });
  assert.equal(owner.ok, true);
  assert.equal(owner.token, "dbp_approved");
  assert.equal(verifyPairToken(owner.state, "dbp_approved"), true);
});

test("mount plans name the drive and follow the 3.36.7 desktop or rclone split", () => {
  const secret = `dbp_${"ab".repeat(32)}`;
  const windows = linkedMountPlan({
    machine: base,
    secret,
    letter: "P",
    platform: "win32",
    home: "/tmp/drivebay-home",
  });
  assert.equal(windows.ok, true);
  assert.match(windows.display, /net use P:/);
  assert.equal(windows.volumeLabel, "Office");
  assert.equal(windows.display.includes(secret), false);

  const mac = linkedMountPlan({
    machine: base,
    secret,
    platform: "darwin",
    home: "/tmp/drivebay-home",
    env: {},
    tools: { gio: false, mount_webdav: true, rclone: true },
  });
  assert.equal(mac.method, "mount_webdav");
  assert.match(mac.mountPoint, /Drivebay/);
  assert.equal(mac.mountPoint.endsWith("DrivebayPhone"), false);

  const headless = linkedMountPlan({
    machine: base,
    secret,
    platform: "linux",
    home: "/tmp/drivebay-home",
    env: {},
    tools: { gio: true, mount_webdav: false, rclone: true },
  });
  assert.equal(headless.method, "rclone");

  const desktop = linkedMountPlan({
    machine: base,
    secret,
    platform: "linux",
    home: "/tmp/drivebay-home",
    env: { DISPLAY: ":0", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" },
    tools: { gio: true, mount_webdav: false, rclone: true },
  });
  assert.equal(desktop.method, "gio");
});

test("WebDAV exposes only the chosen folders and honors read-only", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-share-"));
  const shared = path.join(home, "Photos");
  const secretDir = path.join(home, "Secret");
  fs.mkdirSync(shared);
  fs.mkdirSync(secretDir);
  fs.writeFileSync(path.join(shared, "cat.txt"), "cat");
  fs.writeFileSync(path.join(secretDir, "nope.txt"), "nope");
  const shares = normalizeShares({
    folders: [{ path: shared, access: "ro", name: "Photos" }],
  });
  let state = freshPairState();
  state = redeemCode(issueCode(state, { code: "111111", salt: "s", now: 1 }), {
    code: "111111",
    peerId: "peer-1",
    name: "Laptop",
    now: 2,
    token: "dbp_share",
    tokenSalt: "t",
  }).state;
  const auth = `Basic ${Buffer.from("drivebay:dbp_share").toString("base64")}`;
  const root = handleDav({
    method: "PROPFIND",
    urlPath: "/dav/",
    headers: { authorization: auth, depth: "1" },
    shares,
    pairState: state,
    remoteIsPrivate: true,
  });
  assert.equal(root.status, 207);
  assert.match(root.body.toString(), /Photos/);
  assert.equal(root.body.toString().includes("Secret"), false);
  assert.equal(root.body.toString().includes(secretDir), false);
  const read = handleDav({
    method: "GET",
    urlPath: "/dav/Photos/cat.txt",
    headers: { authorization: auth },
    shares,
    pairState: state,
    remoteIsPrivate: true,
  });
  assert.equal(read.status, 200);
  assert.equal(read.body.toString(), "cat");
  const write = handleDav({
    method: "PUT",
    urlPath: "/dav/Photos/new.txt",
    headers: { authorization: auth },
    body: Buffer.from("no"),
    shares,
    pairState: state,
    remoteIsPrivate: true,
  });
  assert.equal(write.status, 403);
  assert.equal(fs.existsSync(path.join(shared, "new.txt")), false);
  const escape = handleDav({
    method: "GET",
    urlPath: "/dav/Photos/../Secret/nope.txt",
    headers: { authorization: auth },
    shares,
    pairState: state,
    remoteIsPrivate: true,
  });
  assert.notEqual(escape.status, 200);
  const empty = handleDav({
    method: "PROPFIND",
    urlPath: "/dav/",
    headers: { authorization: auth, depth: "1" },
    shares: normalizeShares({}),
    pairState: state,
    remoteIsPrivate: true,
  });
  assert.equal(empty.body.toString().includes("Photos"), false);
  const stranger = handleDav({
    method: "GET",
    urlPath: "/dav/Photos/cat.txt",
    headers: { authorization: "Basic " + Buffer.from("drivebay:nope").toString("base64") },
    shares,
    pairState: state,
    remoteIsPrivate: true,
  });
  assert.equal(stranger.status, 401);
});

test("pairing HTTP stays on the machine and refuses a public peer until the port is opened", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-pair-"));
  writePrivate(path.join(home, "machine-identity.json"), {
    machineId: "machine-office-1",
    displayName: "Office",
    publicKey: "B".repeat(40),
    privateKey: "local-only",
  });
  saveShares(home, { folders: [] });
  const issued = issueLocalCode(home, "654321", 10_000);
  assert.equal(issued.code, "654321");
  assert.equal(JSON.stringify(loadPairState(home)).includes("654321"), false);
  const refused = handleLinkedHttp({
    method: "POST",
    path: "/api/link/redeem",
    body: Buffer.from(JSON.stringify({ code: "654321", machineId: "machine-other-1", displayName: "Laptop" })),
    remoteAddress: "203.0.113.9",
    home,
    now: 11_000,
  });
  return Promise.resolve(refused).then(async (blocked) => {
    assert.equal(blocked.status, 403);
    const ok = await handleLinkedHttp({
      method: "POST",
      path: "/api/link/redeem",
      body: Buffer.from(JSON.stringify({ code: "654321", machineId: "machine-other-1", displayName: "Laptop" })),
      remoteAddress: "100.64.0.9",
      home,
      now: 11_000,
    });
    assert.equal(ok.status, 200);
    const token = JSON.parse(ok.body.toString()).token;
    assert.match(token, /^dbp_/);
    assert.equal(verifyPairToken(loadPairState(home), token), true);
    const who = await handleLinkedHttp({
      method: "GET",
      path: "/api/link/whoami",
      remoteAddress: "100.64.0.9",
      home,
    });
    const body = JSON.parse(who.body.toString());
    assert.equal(body.publicKey, "B".repeat(40));
    assert.equal(body.privateKey, undefined);
  });
});

test("sign-in URLs match Google and Apple and the docs name the cloud rules", () => {
  const google = new URL(googleAuthorizeUrl({ clientId: "google-client", redirectUri: "http://127.0.0.1:8765/settings", nonce: "n1" }));
  assert.equal(google.hostname, "accounts.google.com");
  assert.equal(google.searchParams.get("state"), "google.n1");
  const apple = new URL(appleAuthorizeUrl({ clientId: "apple-client", redirectUri: "http://127.0.0.1:8765/settings", nonce: "n2" }));
  assert.equal(apple.hostname, "appleid.apple.com");
  assert.equal(readIdTokenFragment("#id_token=abc&state=google.n1").provider, "google");
  assert.match(idpPostBody("google.com", "abc"), /providerId=google.com/);
  const docs = fs.readFileSync(path.join(root, "docs/linked-machines.md"), "utf8");
  assert.match(docs, /files never touch/i);
  assert.match(docs, /net use/);
  assert.match(docs, /mount_webdav/);
  assert.match(docs, /rclone/);
  assert.match(docs, /gio/);
  const schema = fs.readFileSync(path.join(root, "server/cloud-api/schema.sql"), "utf8");
  for (const column of ["machine_id", "display_name", "machine_type", "tailscale_host", "lan_address", "public_key", "last_seen"]) {
    assert.match(schema, new RegExp(column));
  }
  assert.equal(/password|token|folder|file_list/i.test(schema), false);
  const php = fs.readFileSync(path.join(root, "server/cloud-api/lib/machines.php"), "utf8");
  assert.match(php, /drivebay_cloud_keys/);
  assert.match(php, /That record is not connection info\.|return null/);
  const ui = fs.readFileSync(path.join(root, "app/src/components/settings/linked-machines.tsx"), "utf8");
  assert.match(ui, /Continue with Google/);
  assert.match(ui, /Continue with Apple/);
  assert.match(ui, /My machines/);
  assert.match(ui, /Read-only/);
  assert.equal(isSpaDocument("/dav", "text/html", "GET"), false);
  assert.equal(isSpaDocument("/api/link/whoami", "text/html", "GET"), false);
});

test("approval helper does not return the token to the settings page", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-approve-"));
  saveShares(home, {});
  const asked = startRequest(freshPairState(), {
    id: "req-ui",
    fromId: "machine-other-1",
    name: "Laptop",
    secret: "request-secret-value",
    salt: "salt-r",
    now: 1,
  });
  writePrivate(path.join(home, "pair-state.json"), asked);
  const result = approveLocalRequest(home, "req-ui", 2);
  assert.equal(result.ok, true);
  assert.equal(result.token, undefined);
});
