import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
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
import {
  appleAuthorizeUrl,
  emailAuthBody,
  emailAuthError,
  emailAuthUrl,
  emailSession,
  googleAuthorizeUrl,
  idpPostBody,
  passwordOk,
  providerConflictMessage,
  readIdTokenFragment,
} from "../app/src/lib/files/mesa-signin.mjs";
import { verifyEmulatorIdToken } from "../app/src/lib/files/linked-cloud.mjs";
import { loadFirebaseConfig, loadPairState, publicLinks, saveAccount, saveShares, writePrivate } from "../app/src/lib/files/linked-store.mjs";
import { volumeLabel } from "../app/src/lib/files/phone-drive.mjs";

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

test("polling a request that is no longer pending is marked missing so the joiner can send a new one", () => {
  const state = freshPairState();
  const missing = pollRequest(state, { id: "req-gone", secret: "request-secret-value" });
  assert.equal(missing.ok, false);
  assert.equal(missing.missing, true);
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
  assert.equal(windows.userFacing, "Office");
  assert.equal(/[A-Z]:/.test(windows.userFacing), false);
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
  assert.equal(mac.mountPoint, path.join("/tmp/drivebay-home", "Drivebay", "Office"));
  assert.equal(mac.args[0], "-v");
  assert.equal(mac.args[1], "Office");
  assert.equal(mac.userFacing, "Office");

  const headless = linkedMountPlan({
    machine: base,
    secret,
    platform: "linux",
    home: "/tmp/drivebay-home",
    env: {},
    tools: { gio: true, mount_webdav: false, rclone: true },
  });
  assert.equal(headless.method, "rclone");
  assert.equal(headless.mountPoint, path.join("/tmp/drivebay-home", "Drivebay", "Office"));
  assert.ok(headless.args.includes("--volname"));
  assert.equal(headless.userFacing, "Office");

  const desktop = linkedMountPlan({
    machine: base,
    secret,
    platform: "linux",
    home: "/tmp/drivebay-home",
    env: { DISPLAY: ":0", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" },
    tools: { gio: true, mount_webdav: false, rclone: true },
  });
  assert.equal(desktop.method, "gio");
  assert.equal(desktop.userFacing, "Office");

  const named = { ...base, displayName: "Aaron's Mac Mini" };
  const firstName = linkedMountPlan({
    machine: named,
    secret,
    platform: "win32",
    home: "/tmp/drivebay-home",
  });
  assert.equal(firstName.volumeLabel, "Aaron's Mac Mini");
  const secondName = linkedMountPlan({
    machine: { ...named, machineId: "machine-office-2" },
    secret,
    platform: "darwin",
    home: "/tmp/drivebay-home",
    env: {},
    tools: { gio: false, mount_webdav: true, rclone: true },
    takenLabels: ["Aaron's Mac Mini"],
  });
  assert.equal(secondName.volumeLabel, "Aaron's Mac Mini 2");
  assert.equal(secondName.mountPoint.endsWith("Aaron's Mac Mini 2"), true);
  assert.equal(volumeLabel("Aaron's Mac Mini"), "Aaron's Mac Mini");
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
  assert.match(docs, /ShowDriveLettersFirst/);
  assert.match(docs, /does not add a password/i);
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
  assert.match(ui, /Create account/);
  assert.match(ui, /Send reset link/);
  assert.match(ui, /My machines/);
  const phoneUi = fs.readFileSync(path.join(root, "app/src/components/settings/phone-drive.tsx"), "utf8");
  assert.equal(phoneUi.includes("Windows drive letter"), false);
  assert.equal(phoneUi.includes("phone-letter"), false);
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

test("email sign-in stores the Firebase tokens and not the password", async () => {
  const password = "correct horse battery";
  assert.equal(passwordOk(password), true);
  assert.equal(passwordOk("short"), false);
  assert.match(providerConflictMessage(["google.com"]), /Google/);
  assert.match(providerConflictMessage(["apple.com"]), /Apple/);
  assert.match(providerConflictMessage(["password"]), /Sign in with it/);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-email-"));
  writePrivate(path.join(home, "mesa-firebase.json"), {
    apiKey: "demo-key",
    authDomain: "demo.firebaseapp.com",
    projectId: "mesa-demo",
    cloudApi: "http://127.0.0.1:9/api",
    authEmulator: "http://127.0.0.1:9099",
  });
  const config = loadFirebaseConfig(home);
  assert.equal(config.ready, true);
  assert.equal(config.authEmulator, "http://127.0.0.1:9099");
  const remote = loadFirebaseConfig(home);
  writePrivate(path.join(home, "mesa-firebase.json"), { ...JSON.parse(fs.readFileSync(path.join(home, "mesa-firebase.json"), "utf8")), authEmulator: "https://evil.example" });
  assert.equal(loadFirebaseConfig(home).authEmulator, "");

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      if (Object.prototype.hasOwnProperty.call(body, "password")) assert.equal(body.password, password);
      const payload = { sub: "uid-email-1", aud: "mesa-demo", email: body.email, exp: Math.floor(Date.now() / 1000) + 3600 };
      const idToken = `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
      res.setHeader("content-type", "application/json");
      if (req.url.includes("sendOobCode")) {
        res.end(JSON.stringify({ email: body.email }));
        return;
      }
      if (req.url.includes("signUp") && body.email === "taken@example.com") {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: { message: "EMAIL_EXISTS" } }));
        return;
      }
      res.end(JSON.stringify({ idToken, refreshToken: "refresh-email-1", expiresIn: "3600", email: body.email, localId: "uid-email-1" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const emulatorConfig = { ...remote, authEmulator: `http://127.0.0.1:${port}`, apiKey: "demo-key", projectId: "mesa-demo" };
  try {
    const signIn = await fetch(emailAuthUrl(emulatorConfig, "signIn"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(emailAuthBody("signIn", { email: "ada@example.com", password })),
    });
    const signed = await signIn.json();
    const session = emailSession(signed);
    assert.ok(session);
    assert.equal(session.refreshToken, "refresh-email-1");
    assert.equal(JSON.stringify(session).includes(password), false);
    const verified = verifyEmulatorIdToken(session.idToken, emulatorConfig);
    assert.equal(verified.uid, "uid-email-1");
    assert.equal(verified.email, "ada@example.com");
    saveAccount(home, {
      uid: verified.uid,
      email: verified.email,
      displayName: "",
      idToken: session.idToken,
      refreshToken: session.refreshToken,
      expiresAt: Date.now() + session.expiresIn * 1000,
    });
    const stored = fs.readFileSync(path.join(home, "mesa-account.json"), "utf8");
    assert.equal(stored.includes(password), false);
    assert.match(stored, /uid-email-1/);
    assert.match(stored, /refresh-email-1/);
    const links = publicLinks({ "machine-office-1": { letter: "P", label: "Office", token: "dbp_secret", url: "http://127.0.0.1/" } });
    assert.equal(links[0].letter, undefined);
    assert.equal(JSON.stringify(links).includes("dbp_secret"), false);
    const reset = await fetch(emailAuthUrl(emulatorConfig, "reset"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(emailAuthBody("reset", { email: "ada@example.com" })),
    });
    assert.equal(reset.status, 200);
    assert.match(emailAuthError("reset", {}).message, /reset link/i);
    const taken = await fetch(emailAuthUrl(emulatorConfig, "signUp"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(emailAuthBody("signUp", { email: "taken@example.com", password })),
    });
    const takenBody = await taken.json();
    assert.equal(emailAuthError("signUp", takenBody).code, "exists");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the PHP token check accepts an email provider and refuses an anonymous one", () => {
  const php = spawnSync("php", ["-r", `
    require ${JSON.stringify(path.join(root, "server/cloud-api/lib/firebase_token.php"))};
    $email = array("firebase" => array("sign_in_provider" => "password"));
    $google = array("firebase" => array("sign_in_provider" => "google.com"));
    $apple = array("firebase" => array("sign_in_provider" => "apple.com"));
    $anon = array("firebase" => array("sign_in_provider" => "anonymous"));
    $missing = array("sub" => "abc");
    echo drivebay_firebase_provider_allowed($email) ? "email " : "no-email ";
    echo drivebay_firebase_provider_allowed($google) ? "google " : "no-google ";
    echo drivebay_firebase_provider_allowed($apple) ? "apple " : "no-apple ";
    echo drivebay_firebase_provider_allowed($anon) ? "anon " : "no-anon ";
    echo drivebay_firebase_provider_allowed($missing) ? "missing" : "no-missing";
  `], { encoding: "utf8" });
  if (php.error && php.error.code === "ENOENT") return;
  assert.equal(php.status, 0, php.stderr);
  assert.equal(php.stdout.trim(), "email google apple no-anon missing");
});

test("own machines in My machines join with a password, not a 6-digit code", () => {
  const ui = fs.readFileSync(path.join(root, "app/src/components/settings/linked-machines.tsx"), "utf8");
  const start = ui.indexOf("export function MyMachinesSection");
  const end = ui.indexOf("export function SharingSection");
  assert.ok(start >= 0 && end > start);
  const mine = ui.slice(start, end);
  const sharing = ui.slice(end);
  assert.match(mine, /data-testid="own-machine-join"/);
  assert.match(mine, /Join/);
  assert.equal(mine.includes("pair-code"), false);
  assert.equal(mine.includes("6-digit code from the other machine"), false);
  assert.equal(/onClick=\{\(\) => void connect\(machine/.test(mine), false);
  assert.match(sharing, /Show a 6-digit code/);
  const panel = fs.readFileSync(path.join(root, "android/app/src/main/java/com/lordstryfe/drivebay/MesaPanel.kt"), "utf8");
  assert.match(panel, /approvePending/);
  assert.equal(panel.includes("with a code (shared folders only)"), false);
  const settings = fs.readFileSync(path.join(root, "app/src/routes/settings.tsx"), "utf8");
  const linked = fs.readFileSync(path.join(root, "app/src/components/settings/linked-machines.tsx"), "utf8");
  assert.match(settings, /<JoinRequestsBanner \/>/);
  assert.match(linked, /data-testid="join-request-banner"/);
  assert.match(linked, /export function JoinRequestsBanner/);
  const bannerAt = settings.indexOf("<JoinRequestsBanner />");
  const accountAt = settings.indexOf("id=\"account\"");
  assert.ok(bannerAt >= 0 && accountAt > bannerAt, "Approve must appear at the top of Settings, above Account");
});
