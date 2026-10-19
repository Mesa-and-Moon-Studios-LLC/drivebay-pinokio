import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "installer/unix/install.sh");
const uninstall = path.join(root, "installer/unix/uninstall.sh");

function bash() {
  const found = spawnSync("bash", ["--version"], { encoding: "utf8" });
  return found.status === 0;
}

test("unix install writes the account, updates in place, and uninstalls", { skip: !bash() }, () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-src-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-home-"));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-bin-"));
  fs.writeFileSync(path.join(source, "VERSION.txt"), "Drivebay for Pinokio - 3.36.2\n");
  fs.writeFileSync(path.join(source, "node-version.txt"), "22.23.3\n");
  fs.writeFileSync(path.join(source, "launcher.mjs"), "console.log('drivebay')\n");
  fs.mkdirSync(path.join(source, "app"));
  fs.writeFileSync(path.join(source, "app/marker.txt"), "program\n");
  const password = "p@ss word";
  const env = {
    ...process.env,
    DRIVEBAY_SOURCE: source,
    DRIVEBAY_HOME: home,
    DRIVEBAY_BIN_DIR: bin,
    DRIVEBAY_SETUP_MODE: "tailscale",
    DRIVEBAY_PORT: "28765",
    DRIVEBAY_USER: "alice",
    DRIVEBAY_PASSWORD: password,
    DRIVEBAY_SKIP_NODE: "1",
    DRIVEBAY_SKIP_SERVICE: "1",
    DRIVEBAY_SKIP_START: "1",
  };
  try {
    const first = spawnSync("bash", [script], { encoding: "utf8", env, timeout: 20000 });
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    assert.match(first.stdout, /Drivebay is installed/);
    assert.equal(first.stdout.includes(password), false);
    const config = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
    assert.equal(config.mode, "tailscale");
    assert.equal(config.port, 28765);
    assert.equal(config.version, "3.36.2");
    const pending = JSON.parse(fs.readFileSync(path.join(home, "pending-account.json"), "utf8"));
    assert.equal(pending.username, "alice");
    assert.equal(pending.password, password);
    assert.equal(fs.readFileSync(path.join(home, "program/app/marker.txt"), "utf8").trim(), "program");
    const wrapper = fs.readFileSync(path.join(bin, "drivebay"), "utf8");
    assert.equal(wrapper.includes(password), false);
    assert.match(wrapper, /launcher\.mjs/);

    fs.writeFileSync(path.join(source, "app/marker.txt"), "replaced\n");
    const second = spawnSync("bash", [script], { encoding: "utf8", env, timeout: 20000 });
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    assert.match(second.stdout, /Drivebay updated to 3\.36\.2\n/);
    fs.writeFileSync(path.join(source, "VERSION.txt"), "Drivebay for Pinokio - 3.36.3\n");
    const third = spawnSync("bash", [script], { encoding: "utf8", env, timeout: 20000 });
    assert.equal(third.status, 0, `${third.stdout}\n${third.stderr}`);
    assert.match(third.stdout, /Drivebay updated to 3\.36\.3\n/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")).version, "3.36.3");
    assert.match(second.stdout, /Drivebay updated to 3\.36/);
    const kept = JSON.parse(fs.readFileSync(path.join(home, "pending-account.json"), "utf8"));
    assert.equal(kept.password, password);
    assert.equal(fs.readFileSync(path.join(home, "program/app/marker.txt"), "utf8").trim(), "replaced");

    const removed = spawnSync("bash", [uninstall], {
      encoding: "utf8",
      env: { ...env, DRIVEBAY_UNINSTALL_FORCE: "1" },
      timeout: 20000,
    });
    assert.equal(removed.status, 0, `${removed.stdout}\n${removed.stderr}`);
    assert.match(removed.stdout, /Drivebay is uninstalled/);
    assert.equal(fs.existsSync(path.join(home, "program")), false);
    assert.equal(fs.existsSync(path.join(bin, "drivebay")), false);
    assert.equal(fs.existsSync(home), false);
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});
