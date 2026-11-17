import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const lib = await import("../app/src/lib/files/linked-explorer.mjs");
const store = await import("../app/src/lib/files/linked-store.mjs");
const machines = await import("../app/src/lib/files/linked-machines.mjs");

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-explorer-"));
}

test("preferred proxy ports stay in range and are stable per machine", () => {
  const first = lib.preferredProxyPort("phone-1978c6ebc8c04036");
  const again = lib.preferredProxyPort("phone-1978c6ebc8c04036");
  const other = lib.preferredProxyPort("d45ee380-ce60-4bdf-9f01-4e2c6ea1e454");
  assert.equal(first, again);
  assert.ok(first >= lib.PROXY_PORT_MIN && first < lib.PROXY_PORT_MIN + lib.PROXY_PORT_SPAN);
  assert.ok(other >= lib.PROXY_PORT_MIN && other < lib.PROXY_PORT_MIN + lib.PROXY_PORT_SPAN);
  assert.notEqual(first, other);
});

test("Show in Explorer defaults to on, and only an explicit false turns it off", () => {
  assert.equal(lib.showInExplorerEnabled(undefined), true);
  assert.equal(lib.showInExplorerEnabled({}), true);
  assert.equal(lib.showInExplorerEnabled({ showInExplorer: true }), true);
  assert.equal(lib.showInExplorerEnabled({ showInExplorer: false }), false);
});

test("a full-scope mesh argument is not treated as a drive letter", () => {
  const letter = lib.resolvedLetter({}, "machine-a", "full");
  assert.equal(letter, "P");
  const kept = lib.resolvedLetter({ "machine-a": { letter: "Q" } }, "machine-a", "full");
  assert.equal(kept, "Q");
  const next = lib.resolvedLetter({ "machine-a": { letter: "P" } }, "machine-b", "full");
  assert.equal(next, "Q");
  assert.equal(machines.pickDriveLetter({}, "machine-a", "full"), "P");
});

test("loopback mount URLs keep the peer path so WebDAV hrefs stay valid", () => {
  assert.equal(lib.localMountUrl(18781, "http://100.127.150.105:8765/dav/"), "http://127.0.0.1:18781/dav/");
  assert.equal(lib.localMountUrl(18782, "http://100.70.170.22:8780/"), "http://127.0.0.1:18782/");
});

test("MountPoints2 keys cover both DavWWWRoot and a /dav path", () => {
  const dav = lib.mountPointsKeys("http://127.0.0.1:18781/dav/");
  assert.ok(dav.includes("##127.0.0.1@18781#DavWWWRoot"));
  assert.ok(dav.includes("##127.0.0.1@18781#dav"));
  const root = lib.mountPointsKeys("http://127.0.0.1:18782/");
  assert.deepEqual(root, ["##127.0.0.1@18782#DavWWWRoot"]);
});

test("PROPFIND hrefs and MOVE destinations are rewritten to the loopback URL", () => {
  const target = "http://100.127.150.105:8765/dav/";
  const local = "http://127.0.0.1:18781/dav/";
  const body = lib.rewriteDavHrefs(
    `<?xml version="1.0"?><d:href>${target}Photos/</d:href>`,
    target,
    local,
  );
  assert.equal(body.includes("100.127.150.105"), false);
  assert.equal(body, `<?xml version="1.0"?><d:href>${local}Photos/</d:href>`);
  assert.equal(
    lib.rewriteRequestDestination("http://127.0.0.1:18781/dav/Photos", local, target),
    "http://100.127.150.105:8765/dav/Photos",
  );
});

test("net use rows parse with or without a status column, and match loopback mappings", () => {
  const rows = lib.parseNetUseRows(`
Status       Local     Remote                    Network
-------------------------------------------------------------------------------
             P:        \\\\100.127.150.105@8765\\dav
OK           Z:        \\\\127.0.0.1@18782\\DavWWWRoot      Web Client Network
The command completed successfully.
`);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].letter, "P");
  assert.equal(rows[0].remote, "\\\\100.127.150.105@8765\\dav");
  assert.equal(rows[1].letter, "Z");
  assert.equal(lib.mappingMatches(rows[0].remote, "http://127.0.0.1:18781/dav/"), false);
  assert.equal(lib.mappingMatches(rows[1].remote, "http://127.0.0.1:18782/"), true);
  assert.equal(lib.mappingMatches("\\\\127.0.0.1@18781\\dav", "http://127.0.0.1:18781/dav/"), true);
});

test("the loopback proxy injects the grant token and hides the upstream host", async () => {
  const seen = { auth: "", dest: "" };
  const upstream = http.createServer((req, res) => {
    seen.auth = String(req.headers.authorization || "");
    seen.dest = String(req.headers.destination || "");
    res.writeHead(207, { "Content-Type": "application/xml" });
    res.end(`<?xml version="1.0"?><d:href>${targetHref}DCIM/</d:href>`);
  });
  const token = "db_testtoken_for_proxy_unit";
  let proxy;
  let targetHref = "";
  try {
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upPort = upstream.address().port;
    const targetUrl = `http://127.0.0.1:${upPort}/`;
    targetHref = targetUrl;
    proxy = lib.createMountProxy({ targetUrl, token, localUrl: "http://127.0.0.1:9/" });
    await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const port = proxy.address().port;
    proxy.drivebayState.localUrl = `http://127.0.0.1:${port}/`;
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "PROPFIND",
      headers: { Destination: `http://127.0.0.1:${port}/DCIM` },
    });
    const body = await response.text();
    assert.equal(response.status, 207);
    assert.equal(seen.auth, lib.basicAuthHeader(token));
    assert.equal(seen.dest, `http://127.0.0.1:${upPort}/DCIM`);
    assert.equal(body.includes(`http://127.0.0.1:${upPort}/`), false);
    assert.equal(body.includes(`http://127.0.0.1:${port}/DCIM/`), true);
  } finally {
    if (proxy) await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("turning Show in Explorer off keeps the token and records the toggle", async () => {
  const home = tmpHome();
  store.saveLinkedTokens(home, {
    "machine-office-1": {
      token: "dbp_saved_token_value",
      url: "http://100.127.150.105:8765/dav/",
      label: "Office",
      letter: "P",
      scope: "full",
    },
  });
  const hidden = await lib.setShowInExplorer(home, "machine-office-1", false);
  assert.equal(hidden.ok, true);
  const records = store.loadLinkedTokens(home);
  assert.equal(records["machine-office-1"].token, "dbp_saved_token_value");
  assert.equal(records["machine-office-1"].showInExplorer, false);
  assert.equal(lib.showInExplorerEnabled(records["machine-office-1"]), false);
  lib.stopLinkedExplorer();
  fs.rmSync(home, { recursive: true, force: true });
});

test("volume labels use the device display name", async () => {
  const { volumeLabel } = await import(pathToFileURL(path.resolve("app/src/lib/files/phone-drive.mjs")).href);
  assert.equal(volumeLabel("SM-S938U1"), "SM-S938U1");
  assert.equal(volumeLabel("Lordstryfes-Mac-Mini.local"), "Lordstryfes-Mac-Mini.local");
  assert.equal(volumeLabel("Aaron's Mac"), "Aaron's Mac");
});

test("an ordinary folder is not treated as a mounted volume", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-not-mounted-"));
  assert.equal(lib.isPathMounted(dir), false);
  assert.equal(lib.isPathMounted(path.join(dir, "missing")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("blocked local volume letters are not chosen for a mount", () => {
  const letter = lib.resolvedLetter({ "machine-phone-1": { letter: "Z" } }, "machine-phone-1", "Z", ["C", "D", "G", "X", "Z"]);
  assert.equal(letter, "P");
  const next = lib.resolvedLetter({ "machine-mac-1": { letter: "P" }, "machine-phone-1": { letter: "Z" } }, "machine-phone-1", "Z", ["C", "D", "G", "X", "Z"]);
  assert.equal(next, "Q");
});
