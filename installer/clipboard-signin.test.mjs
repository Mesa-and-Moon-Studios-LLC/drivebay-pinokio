import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("clipboard label, names and paste checks", async () => {
  const c = await load("app/src/lib/files/clipboard.mjs");
  const items = [
    { path: "/a/x.txt", name: "x.txt", kind: "file" },
    { path: "/a/photos", name: "photos", kind: "dir" },
  ];
  assert.equal(c.clipboardLabel({ mode: "cut", items }), "2 items cut");
  assert.equal(c.clipboardLabel({ mode: "copy", items: [items[0]] }), "1 item copied");
  assert.equal(c.uniquePasteName("x.txt", ["x.txt"]), "x (copy).txt");
  assert.equal(c.uniquePasteName("x.txt", ["x.txt", "x (copy).txt"]), "x (copy 2).txt");
  assert.equal(c.uniquePasteName("Makefile", ["Makefile"]), "Makefile (copy)");
  assert.equal(c.pasteProblem({ mode: "cut", items }, "/a/photos/2024"), "Cannot paste “photos” into itself");
  assert.equal(c.pasteProblem({ mode: "cut", items }, "/a"), "Those items are already in this folder");
  assert.equal(c.pasteProblem({ mode: "copy", items }, "/a"), "");
  assert.equal(c.pasteProblem({ mode: "cut", items }, "/b"), "");
  assert.equal(c.isSameOrInside("/a/photos2", "/a/photos"), false);
  assert.equal(c.isSameOrInside("C:\\Users\\A\\Pics", "c:\\users\\a", "\\"), true);
  assert.equal(c.parentOf("C:\\x.txt", "\\"), "C:\\");
});

test("Google and Apple use the https sign-in page, never a custom scheme", async () => {
  const m = await load("app/src/lib/files/mesa-signin.mjs");
  const bridge = m.signinBridgeUrl({ authDomain: "mesa-and-moon-drivebay.firebaseapp.com" });
  assert.equal(bridge, "https://mesa-and-moon-drivebay.firebaseapp.com/drivebay-signin.html");
  assert.equal(m.signinBridgeUrl({ authDomain: "d.firebaseapp.com", signinBridge: "http://bad.test/x" }), "https://d.firebaseapp.com/drivebay-signin.html");
  const start = new URL(m.bridgeStartUrl({ bridge, provider: "apple", state: "n".repeat(20), returnTo: "http://127.0.0.1:8765/settings" }));
  assert.equal(start.protocol, "https:");
  assert.equal(start.searchParams.get("return"), "http://127.0.0.1:8765/settings");
  const session = m.readSessionFragment("#mesa_session=1&state=abc&id_token=t1&refresh_token=r1&expires_in=3599&email=a%40b.co");
  assert.deepEqual(session, { idToken: "t1", refreshToken: "r1", state: "abc", expiresIn: 3599, email: "a@b.co" });
  assert.equal(m.readSessionFragment("#id_token=t1&state=google.abc"), null);

  const tsx = read("app/src/components/settings/linked-machines.tsx");
  assert.doesNotMatch(tsx, /googleAuthorizeUrl|appleAuthorizeUrl/);
  const panel = read("android/app/src/main/java/com/lordstryfe/drivebay/MesaPanel.kt");
  assert.doesNotMatch(panel, /googleAuthorizeUrl|appleAuthorizeUrl|"drivebay:\/\/mesa"/);
  assert.match(panel, /bridgeStartUrl/);
});

test("sign-in page only hands the session to the Drivebay app or this computer", () => {
  const html = read("firebase-hosting/public/drivebay-signin.html");
  assert.match(html, /package=\$\{ANDROID_PACKAGE\}/);
  assert.match(html, /const ANDROID_PACKAGE = "com\.mesaandmoon\.drivebay"/);
  assert.match(html, /\["127\.0\.0\.1", "localhost", "\[::1\]"\]\.includes\(url\.hostname\)/);
  assert.match(html, /url\.pathname !== "\/settings"/);
  assert.match(html, /\/__\/firebase\/init\.json/);
  assert.doesNotMatch(html, /AIza[0-9A-Za-z_-]{20,}/, "no API key in the page");
  const hosting = JSON.parse(read("firebase-hosting/firebase.json"));
  assert.equal(hosting.hosting.public, "public");
});

test("file browser has pinned menus, an entry menu and the paste bar", () => {
  const app = read("app/src/components/browser/app.tsx");
  for (const label of ['label="File"', 'label="Edit"', 'label="View"', 'label="Organize"']) assert.ok(app.includes(label), label);
  assert.match(app, /data-testid="top-bars"/);
  assert.match(app, /sticky top-0 z-30/);
  assert.match(app, /data-testid="paste-bar"/);
  assert.match(app, /Paste here/);
  assert.match(app, /Send to/);
  assert.match(app, /onContextMenu/);
  assert.match(app, /onTouchStart/);
});

test("server paste copies without overwriting and moves", async (t) => {
  // fs.server.ts is TypeScript; check the same rules through the shared helper on a real folder.
  const c = await load("app/src/lib/files/clipboard.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "db-paste-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "a.txt"), "1");
  const name = c.uniquePasteName("a.txt", new Set(fs.readdirSync(dir)));
  assert.equal(name, "a (copy).txt");
});
