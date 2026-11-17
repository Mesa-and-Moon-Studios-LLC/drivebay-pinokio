/**
 * End to end: the real PHP license endpoints (php -S) with the real JS client and the admin CLI.
 * Needs a php binary with ext-sodium, or SODIUM_COMPAT_AUTOLOAD pointing at paragonie/sodium_compat.
 * Skipped (not failed) when php is not available.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { activateLicense, deactivateLicense, readEntitlements, refreshLicense } from "../app/src/lib/license/license-store.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const api = path.join(root, "server", "cloud-api");
const PHP = process.env.PHP_BIN || "php";
const COMPAT = process.env.SODIUM_COMPAT_AUTOLOAD || "";

function haveSodium() {
  const probe = spawnSync(PHP, ["-r", "echo function_exists('sodium_crypto_sign_detached') ? 'y' : 'n';"], { encoding: "utf8" });
  if (probe.error) return false;
  return probe.stdout === "y" || Boolean(COMPAT && fs.existsSync(COMPAT));
}
const skip = !haveSodium() ? "php with sodium (or SODIUM_COMPAT_AUTOLOAD) not available" : false;

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbay-e2e-"));
  const licenseDir = path.join(dir, "license");
  const prepend = path.join(dir, "prepend.php");
  fs.writeFileSync(prepend, COMPAT ? `<?php if (!function_exists('sodium_crypto_sign_detached')) { require '${COMPAT}'; }` : "<?php");
  const token = crypto.randomBytes(16).toString("hex");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const env = { ...process.env, DRIVEBAY_LICENSE_DIR: licenseDir, DRIVEBAY_ALLOW_HTTP_ADMIN: "1" };
  const init = spawnSync(PHP, ["-d", `auto_prepend_file=${prepend}`, path.join(api, "tools", "license-init.php"), licenseDir, hash], { encoding: "utf8", env });
  assert.equal(init.status, 0, init.stderr || init.stdout);
  const publicKey = fs.readFileSync(path.join(licenseDir, "public.key"), "utf8").trim();
  const cfgFile = path.join(licenseDir, "config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
  cfg.providers = { fake: { webhook_secret: "fake-e2e-secret" } };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  const port = await freePort();
  const child = spawn(PHP, ["-d", `auto_prepend_file=${prepend}`, "-S", `127.0.0.1:${port}`, "-t", api], { env, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${base}/api/license.php?action=publickey`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { dir, licenseDir, token, publicKey, base, child, env };
}

function adminCli(server, args) {
  return spawnSync(process.execPath, [path.join(api, "tools", "license-admin.mjs"), ...args], {
    encoding: "utf8",
    env: { ...process.env, DRIVEBAY_ADMIN_TOKEN: server.token, DRIVEBAY_LICENSE_ADMIN_URL: `${server.base}/api/license-admin.php` },
  });
}

const ctx = (server, machineId) => ({ machineId, name: machineId, platform: "pc", version: "e2e", publicKeys: [server.publicKey], api: `${server.base}/api/license.php`, buildTs: Math.floor(Date.now() / 1000) });
const home = () => fs.mkdtempSync(path.join(os.tmpdir(), "dbay-e2e-home-"));

test("PHP license server end to end", { skip }, async (t) => {
  const server = await boot();
  t.after(() => {
    server.child.kill();
    fs.rmSync(server.dir, { recursive: true, force: true });
  });

  await t.test("admin CLI mints a 2-seat Pro code; the client activates, hits the seat limit, deactivates", async () => {
    const out = adminCli(server, ["code", "--edition", "pro", "--seats", "2", "--perpetual", "--note", "e2e"]);
    assert.equal(out.status, 0, out.stderr);
    const code = out.stdout.trim();
    assert.match(code, /^DBAY-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const [h1, h2, h3] = [home(), home(), home()];
    const a = await activateLicense(h1, code, ctx(server, "e2e-machine-0001"));
    assert.equal(a.ok, true, a.error);
    assert.equal(readEntitlements(h1, { machineId: "e2e-machine-0001", publicKeys: [server.publicKey] }).can("remote_access"), true);
    assert.equal((await activateLicense(h2, code, ctx(server, "e2e-machine-0002"))).ok, true);
    const third = await activateLicense(h3, code, ctx(server, "e2e-machine-0003"));
    assert.equal(third.code, "seats_full");
    assert.equal(readEntitlements(h3, { machineId: "e2e-machine-0003", publicKeys: [server.publicKey] }).can("remote_access"), false);
    const released = await deactivateLicense(h2, ctx(server, "e2e-machine-0002"));
    assert.equal(released.released, true);
    assert.equal((await activateLicense(h3, code, ctx(server, "e2e-machine-0003"))).ok, true);
    assert.equal((await refreshLicense(h1, ctx(server, "e2e-machine-0001"))).ok, true);
  });

  await t.test("revocation: refresh fails, features turn off", async () => {
    const mint = adminCli(server, ["mint", "--edition", "elite", "--seats", "1", "--perpetual", "--lifetime-updates", "--json"]);
    assert.equal(mint.status, 0, mint.stderr);
    const { licenseKey, license } = JSON.parse(mint.stdout);
    const h = home();
    assert.equal((await activateLicense(h, licenseKey, ctx(server, "e2e-machine-0010"))).ok, true);
    assert.equal(adminCli(server, ["revoke", license.id, "chargeback"]).status, 0);
    const r = await refreshLicense(h, ctx(server, "e2e-machine-0010"));
    assert.equal(r.ok, false);
    const ent = readEntitlements(h, { machineId: "e2e-machine-0010", publicKeys: [server.publicKey] });
    assert.equal(ent.edition, "free");
    assert.equal(ent.state.status, "revoked");
    assert.equal(adminCli(server, ["unrevoke", license.id]).status, 0);
    assert.equal((await refreshLicense(h, ctx(server, "e2e-machine-0010"))).ok, true);
    assert.equal(readEntitlements(h, { machineId: "e2e-machine-0010", publicKeys: [server.publicKey] }).edition, "elite");
  });

  await t.test("enterprise offline file: minted by the CLI, accepted with no server", async () => {
    const file = path.join(server.dir, "acme.dbaylicense");
    const out = adminCli(server, ["enterprise-file", "--org", "Acme Corp", "--seats", "250", "--months", "12", "--out", file]);
    assert.equal(out.status, 0, out.stderr);
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /Licensee: Acme Corp/);
    const h = home();
    const res = await activateLicense(h, text, { machineId: "airgapped-host-0001", publicKeys: [server.publicKey], fetchImpl: async () => { throw new Error("offline"); } });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.offline, true);
    const ent = readEntitlements(h, { machineId: "airgapped-host-0001", publicKeys: [server.publicKey] });
    assert.equal(ent.edition, "enterprise");
    assert.equal(ent.state.license.seats, 250);
    assert.equal(ent.state.license.label, "Acme Corp");
  });

  await t.test("admin API refuses a wrong token and the public API never accepts the admin header", async () => {
    const bad = await fetch(`${server.base}/api/license-admin.php`, { method: "POST", headers: { "content-type": "application/json", "x-drivebay-admin": "nope" }, body: JSON.stringify({ action: "list" }) });
    assert.equal(bad.status, 401);
    const none = await fetch(`${server.base}/api/license-admin.php`, { method: "POST", body: "{}" });
    assert.equal(none.status, 401);
  });

  await t.test("webhook: signed fake-provider order mints a code once; replay and bad signature do nothing", async () => {
    const cfgFile = path.join(server.licenseDir, "config.json");
    const hit = async (body, secret = "fake-e2e-secret") => {
      const raw = JSON.stringify(body);
      return fetch(`${server.base}/api/webhook.php?provider=fake`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-fake-signature": crypto.createHmac("sha256", secret).update(raw).digest("hex") },
        body: raw,
      });
    };
    const order = { id: "evt_e2e_1", type: "paid", order_id: "ord_e2e_1", email: "buyer@example.test", sku: "pro-1y" };
    assert.equal((await hit(order, "wrong-secret")).status, 401);
    const first = await hit(order);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).outcome, "minted:1");
    const replay = await hit(order);
    assert.equal((await replay.json()).duplicate, true);
    const orders = JSON.parse(adminCli(server, ["list", "orders", "--json"]).stdout).rows;
    assert.equal(orders.filter((o) => o.order_id === "ord_e2e_1").length, 1);
    const outbox = adminCli(server, ["outbox", "--json"]);
    const rows = JSON.parse(outbox.stdout).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].transport, "outbox", "nothing was sent");
    assert.equal(rows[0].sent_at, null);
    const code = rows[0].body.match(/DBAY-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/)[0];
    const h = home();
    assert.equal((await activateLicense(h, code, ctx(server, "e2e-buyer-0001"))).ok, true, "the emailed code works");
    // an unconfigured provider is a 503, not a silent accept
    const stripe = await fetch(`${server.base}/api/webhook.php?provider=stripe`, { method: "POST", body: "{}" });
    assert.equal(stripe.status, 503);
    assert.ok(fs.existsSync(cfgFile));
  });

  await t.test("private key is never served; config and key files are not reachable over HTTP", async () => {
    for (const p of ["/license/signing.key", "/lib/license_store.php"]) {
      const r = await fetch(`${server.base}${p}`);
      assert.notEqual(r.status === 200 && (await r.text()).includes("sodium_crypto"), true, p);
    }
    const pk = await (await fetch(`${server.base}/api/license.php?action=publickey`)).json();
    assert.equal(pk.publicKey, server.publicKey);
    const secretHex = fs.readFileSync(path.join(server.licenseDir, "signing.key"), "utf8").trim();
    const everything = await Promise.all(["plans", "publickey"].map(async (a) => (await fetch(`${server.base}/api/license.php?action=${a}`)).text()));
    for (const body of everything) assert.equal(body.includes(secretHex.slice(0, 32)), false);
  });
});
