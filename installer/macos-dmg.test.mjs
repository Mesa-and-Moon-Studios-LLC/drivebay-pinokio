import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const setup = path.join(root, "installer/macos/drivebay-setup.sh");
const pack = path.join(root, "installer/macos/package-dmg.sh");
const sign = path.join(root, "installer/macos/sign-dmg.sh");

function bash() {
  return spawnSync("bash", ["--version"], { encoding: "utf8" }).status === 0;
}

function writeExe(file, body) {
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
}

function payload(dir, version = "3.36.2") {
  fs.mkdirSync(path.join(dir, "unix"), { recursive: true });
  fs.writeFileSync(path.join(dir, "VERSION.txt"), `Drivebay for Pinokio - ${version}\n`);
  fs.writeFileSync(path.join(dir, "launcher.mjs"), "console.log('drivebay')\n");
  writeExe(path.join(dir, "unix/install.sh"), "#!/bin/bash\nprintf '%s\\n' installed\n");
}

function recorder(file, record) {
  writeExe(
    file,
    `#!/bin/bash
cat > "${record}" <<EOF
MODE=\${DRIVEBAY_SETUP_MODE-}
PORT=\${DRIVEBAY_PORT-}
USER=\${DRIVEBAY_USER-}
PASS=\${DRIVEBAY_PASSWORD-}
SOURCE=\${DRIVEBAY_SOURCE-}
EOF
printf '%s\\n' "Drivebay is installed."
`,
  );
}

function runSetup(env) {
  return spawnSync("bash", [setup], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 20000 });
}

test("disk image setup passes the same answers install.sh already accepts", { skip: !bash() }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-dmg-"));
  const source = path.join(dir, "payload");
  const home = path.join(dir, "home");
  const record = path.join(dir, "record.txt");
  const opened = path.join(dir, "opened.txt");
  const replies = path.join(dir, "replies.txt");
  payload(source);
  recorder(path.join(dir, "install-stub.sh"), record);
  writeExe(path.join(dir, "open.sh"), `#!/bin/bash\nprintf '%s\\n' "$1" > "${opened}"\n`);
  const password = "p@ss word";
  fs.writeFileSync(
    replies,
    ["Tailscale (recommended)", "99", "8765", 'ann "o', "short", password, "different", password, password, ""].join("\n"),
  );
  try {
    const result = runSetup({
      DRIVEBAY_SOURCE: source,
      DRIVEBAY_HOME: home,
      DRIVEBAY_INSTALL_SH: path.join(dir, "install-stub.sh"),
      DRIVEBAY_UI_REPLIES: replies,
      DRIVEBAY_OPEN: path.join(dir, "open.sh"),
      DRIVEBAY_SKIP_XATTR: "1",
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stdout.includes(password), false);
    assert.equal(result.stderr.includes(password), false);
    const saved = fs.readFileSync(record, "utf8");
    assert.match(saved, /^MODE=tailscale$/m);
    assert.match(saved, /^PORT=8765$/m);
    assert.match(saved, /^USER=ann "o$/m);
    assert.match(saved, /^PASS=p@ss word$/m);
    assert.match(saved, new RegExp(`^SOURCE=${source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    assert.match(fs.readFileSync(opened, "utf8"), /http:\/\/127\.0\.0\.1:8765\/settings/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cancel and an already-installed copy do not ask for a new password", { skip: !bash() }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-dmg-"));
  const source = path.join(dir, "payload");
  const home = path.join(dir, "home");
  const record = path.join(dir, "record.txt");
  const opened = path.join(dir, "opened.txt");
  payload(source, "3.36.2");
  recorder(path.join(dir, "install-stub.sh"), record);
  writeExe(path.join(dir, "open.sh"), `#!/bin/bash\nprintf '%s\\n' "$1" > "${opened}"\n`);
  const env = {
    DRIVEBAY_SOURCE: source,
    DRIVEBAY_HOME: home,
    DRIVEBAY_INSTALL_SH: path.join(dir, "install-stub.sh"),
    DRIVEBAY_OPEN: path.join(dir, "open.sh"),
    DRIVEBAY_SKIP_XATTR: "1",
  };
  try {
    fs.writeFileSync(path.join(dir, "replies.txt"), "cancel\n");
    const cancelled = runSetup({ ...env, DRIVEBAY_UI_REPLIES: path.join(dir, "replies.txt") });
    assert.equal(cancelled.status, 0, `${cancelled.stdout}\n${cancelled.stderr}`);
    assert.equal(fs.existsSync(record), false);

    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ port: 9999, mode: "tailscale", version: "3.36.2" }));
    const same = runSetup(env);
    assert.equal(same.status, 0, `${same.stdout}\n${same.stderr}`);
    assert.equal(fs.existsSync(record), false);
    assert.match(fs.readFileSync(opened, "utf8"), /9999\/settings/);

    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ port: 9999, mode: "tailscale", version: "3.36.1" }));
    fs.writeFileSync(path.join(dir, "replies.txt"), "no\n");
    const declined = runSetup({ ...env, DRIVEBAY_UI_REPLIES: path.join(dir, "replies.txt") });
    assert.equal(declined.status, 0, `${declined.stdout}\n${declined.stderr}`);
    assert.equal(fs.existsSync(record), false);

    fs.writeFileSync(path.join(dir, "replies.txt"), "yes\n");
    const updated = runSetup({ ...env, DRIVEBAY_UI_REPLIES: path.join(dir, "replies.txt") });
    assert.equal(updated.status, 0, `${updated.stdout}\n${updated.stderr}`);
    const saved = fs.readFileSync(record, "utf8");
    assert.match(saved, /^MODE=$/m);
    assert.match(saved, /^PASS=$/m);
    assert.match(fs.readFileSync(opened, "utf8"), /9999\/settings/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("osascript prompts use a hidden password and a mode list", { skip: !bash() }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-dmg-"));
  const source = path.join(dir, "payload");
  const home = path.join(dir, "home");
  const record = path.join(dir, "record.txt");
  const scripts = path.join(dir, "scripts.txt");
  payload(source);
  recorder(path.join(dir, "install-stub.sh"), record);
  writeExe(path.join(dir, "open.sh"), "#!/bin/bash\nexit 0\n");
  writeExe(
    path.join(dir, "osascript"),
    `#!/bin/bash
script=$(cat)
printf '%s\\n---\\n' "$script" >> "${scripts}"
if [[ "$script" == *"choose from list"* ]]; then
  printf '%s\\n' "Tailscale (recommended)"
elif [[ "$script" == *"hidden answer"* ]]; then
  printf '%s\\n' "password1"
elif [[ "$script" == *"Username"* ]]; then
  printf '%s\\n' "alice"
elif [[ "$script" == *"Port"* ]]; then
  printf '%s\\n' "8765"
fi
`,
  );
  try {
    const result = runSetup({
      DRIVEBAY_SOURCE: source,
      DRIVEBAY_HOME: home,
      DRIVEBAY_INSTALL_SH: path.join(dir, "install-stub.sh"),
      DRIVEBAY_OSASCRIPT: path.join(dir, "osascript"),
      DRIVEBAY_OPEN: path.join(dir, "open.sh"),
      DRIVEBAY_SKIP_XATTR: "1",
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const text = fs.readFileSync(scripts, "utf8");
    assert.match(text, /choose from list/);
    assert.match(text, /Tailscale \(recommended\)/);
    assert.match(text, /with hidden answer/);
    assert.match(text, /Username/);
    const saved = fs.readFileSync(record, "utf8");
    assert.match(saved, /^USER=alice$/m);
    assert.match(saved, /^PASS=password1$/m);
    assert.equal(result.stdout.includes("password1"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("packaging lays out an app, an Applications shortcut, and the quarantine readme", { skip: !bash() }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-dmg-"));
  const input = path.join(dir, "in");
  const out = path.join(dir, "out");
  const packed = path.join(dir, "tree");
  fs.mkdirSync(input, { recursive: true });
  payload(packed);
  const tar = spawnSync("tar", ["-czf", path.join(input, "drivebay-server-darwin-arm64.tar.gz"), "-C", packed, "."], {
    encoding: "utf8",
  });
  assert.equal(tar.status, 0, tar.stderr);
  try {
    const built = spawnSync("bash", [pack, input], {
      encoding: "utf8",
      env: {
        ...process.env,
        DRIVEBAY_DMG_LAYOUT_ONLY: "1",
        DRIVEBAY_DMG_OUT: out,
      },
      timeout: 20000,
    });
    assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
    const app = path.join(out, "dmg-layout-arm64", "Drivebay.app");
    const plist = fs.readFileSync(path.join(app, "Contents/Info.plist"), "utf8");
    assert.match(plist, /com\.mesaandmoon\.drivebay\.installer/);
    assert.match(plist, /<key>CFBundleShortVersionString<\/key><string>3\.36\.2<\/string>/);
    assert.match(plist, /<key>CFBundleExecutable<\/key><string>Drivebay<\/string>/);
    const exe = fs.readFileSync(path.join(app, "Contents/MacOS/Drivebay"), "utf8");
    assert.match(exe, /drivebay-setup\.sh/);
    const bundleSetup = fs.readFileSync(path.join(app, "Contents/Resources/drivebay-setup.sh"), "utf8");
    assert.match(bundleSetup, /with hidden answer/);
    assert.match(bundleSetup, /unix\/install\.sh/);
    assert.equal(fs.existsSync(path.join(app, "Contents/Resources/payload/launcher.mjs")), true);
    assert.equal(fs.readlinkSync(path.join(out, "dmg-layout-arm64", "Applications")), "/Applications");
    const readme = fs.readFileSync(path.join(out, "dmg-layout-arm64", "README.txt"), "utf8");
    assert.match(readme, /right-click Drivebay and choose Open/);
    assert.match(readme, /xattr -dr com\.apple\.quarantine \/Applications\/Drivebay\.app/);
    assert.match(readme, /drivebay-server-darwin-arm64\.tar\.gz/);

    const bundleHome = path.join(dir, "bundle-home");
    const bundleRecord = path.join(dir, "bundle-record.txt");
    const bundleReplies = path.join(dir, "bundle-replies.txt");
    const bundleOpen = path.join(dir, "bundle-open.txt");
    recorder(path.join(dir, "bundle-install.sh"), bundleRecord);
    writeExe(path.join(dir, "bundle-open.sh"), `#!/bin/bash\nprintf '%s\\n' "$1" > "${bundleOpen}"\n`);
    fs.writeFileSync(
      bundleReplies,
      ["Tailscale (recommended)", "8765", "alice", "password1", "password1", ""].join("\n"),
    );
    const launched = spawnSync("bash", [path.join(app, "Contents/Resources/drivebay-setup.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        DRIVEBAY_HOME: bundleHome,
        DRIVEBAY_INSTALL_SH: path.join(dir, "bundle-install.sh"),
        DRIVEBAY_UI_REPLIES: bundleReplies,
        DRIVEBAY_OPEN: path.join(dir, "bundle-open.sh"),
        DRIVEBAY_SKIP_XATTR: "1",
      },
      timeout: 20000,
    });
    assert.equal(launched.status, 0, `${launched.stdout}\n${launched.stderr}`);
    const bundleSaved = fs.readFileSync(bundleRecord, "utf8");
    assert.match(bundleSaved, /^MODE=tailscale$/m);
    assert.match(bundleSaved, /^USER=alice$/m);
    assert.match(bundleSaved, /^PASS=password1$/m);
    const sourcePath = bundleSaved.split("\n").find((line) => line.startsWith("SOURCE=")).slice("SOURCE=".length);
    assert.equal(fs.existsSync(path.join(sourcePath, "launcher.mjs")), true);
    assert.equal(fs.existsSync(path.join(sourcePath, "unix/install.sh")), true);
    assert.match(fs.readFileSync(bundleOpen, "utf8"), /127\.0\.0\.1:8765\/settings/);

    const both = spawnSync("bash", [pack, input], {
      encoding: "utf8",
      env: { ...process.env, DRIVEBAY_DMG_LAYOUT_ONLY: "1", DRIVEBAY_DMG_OUT: out, DRIVEBAY_DMG_REQUIRE_BOTH: "1" },
      timeout: 20000,
    });
    assert.notEqual(both.status, 0);
    assert.match(both.stderr, /x64/);

    const empty = path.join(dir, "empty");
    fs.mkdirSync(empty);
    const none = spawnSync("bash", [pack, empty], {
      encoding: "utf8",
      env: { ...process.env, DRIVEBAY_DMG_LAYOUT_ONLY: "1", DRIVEBAY_DMG_OUT: out },
      timeout: 20000,
    });
    assert.notEqual(none.status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("signing stays off until APPLE_ secrets are set, and the release keeps the tarballs", { skip: !bash() }, () => {
  const unsigned = spawnSync("bash", [sign, "sign", path.join(os.tmpdir(), "missing.app")], { encoding: "utf8" });
  assert.equal(unsigned.status, 0, `${unsigned.stdout}\n${unsigned.stderr}`);
  assert.match(unsigned.stdout, /right-click Drivebay and choose Open/);
  assert.match(unsigned.stdout, /xattr -dr com\.apple\.quarantine/);
  assert.match(unsigned.stdout, /APPLE_CERTIFICATE/);
  assert.match(unsigned.stdout, /APPLE_NOTARY_KEY/);

  const notarizeOff = spawnSync("bash", [sign, "notarize", path.join(os.tmpdir(), "missing.dmg")], { encoding: "utf8" });
  assert.equal(notarizeOff.status, 0, notarizeOff.stderr);
  assert.match(notarizeOff.stdout, /Notarization is off/);

  const linuxSign = spawnSync("bash", [sign, "sign", path.join(os.tmpdir(), "missing.app")], {
    encoding: "utf8",
    env: { ...process.env, APPLE_CERTIFICATE: "dGVzdA==", APPLE_CERTIFICATE_PASSWORD: "secret" },
  });
  assert.notEqual(linuxSign.status, 0);
  assert.match(linuxSign.stderr, /macOS/);
  assert.equal(linuxSign.stderr.includes("dGVzdA=="), false);
  assert.equal(linuxSign.stdout.includes("secret"), false);

  const notaryWithoutCert = spawnSync("bash", [sign, "notarize", path.join(os.tmpdir(), "missing.dmg")], {
    encoding: "utf8",
    env: {
      ...process.env,
      APPLE_NOTARY_KEY: "not-a-real-key",
      APPLE_NOTARY_KEY_ID: "KEYID",
      APPLE_NOTARY_ISSUER_ID: "issuer",
    },
  });
  assert.notEqual(notaryWithoutCert.status, 0);
  assert.match(notaryWithoutCert.stderr, /APPLE_CERTIFICATE/);
  assert.equal(notaryWithoutCert.stderr.includes("not-a-real-key"), false);
  assert.equal(notaryWithoutCert.stdout.includes("not-a-real-key"), false);

  const workflow = fs.readFileSync(path.join(root, ".github/workflows/windows-installer.yml"), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /macos-dmg/);
  assert.match(workflow, /runs-on: macos-latest/);
  assert.match(workflow, /secrets\.APPLE_CERTIFICATE/);
  assert.match(workflow, /secrets\.APPLE_NOTARY_KEY/);
  assert.match(workflow, /Drivebay-macOS-dmg/);
  assert.match(workflow, /if: startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.match(workflow, /drivebay-server-darwin-arm64\.tar\.gz/);
  assert.match(workflow, /drivebay-server-darwin-x64\.tar\.gz/);
  assert.match(workflow, /version-manifest\.json/);
  assert.match(workflow, /Drivebay-\*\.dmg/);
  const release = workflow.slice(workflow.indexOf("\n  release:"));
  const releaseIf = release.split("\n").find((line) => line.trim().startsWith("if:"));
  assert.ok(releaseIf);
  assert.match(releaseIf, /refs\/tags\/v/);
  assert.equal(releaseIf.includes("workflow_dispatch"), false);

  const notes = fs.readFileSync(path.join(root, "installer/release-notes.txt"), "utf8");
  assert.match(notes, /right-click Drivebay and choose Open/);
  assert.match(notes, /xattr -dr com\.apple\.quarantine/);
  assert.match(notes, /drivebay-server-darwin-arm64\.tar\.gz/);
  assert.match(notes, /version-manifest\.json/);

  const policy = fs.readFileSync(path.join(root, "app/src/lib/files/update-policy.mjs"), "utf8");
  assert.match(policy, /export const MANIFEST_NAME = "version-manifest\.json"/);
  const launcher = fs.readFileSync(path.join(root, "installer/macos/launcher.c"), "utf8");
  assert.match(launcher, /_NSGetExecutablePath/);
  assert.match(launcher, /com\.apple\.quarantine/);
  const packScript = fs.readFileSync(pack, "utf8");
  assert.match(packScript, /-arch arm64/);
  assert.match(packScript, /-arch x86_64/);
  const install = fs.readFileSync(path.join(root, "installer/unix/install.sh"), "utf8");
  assert.match(install, /com\.apple\.quarantine/);
  assert.match(install, /LaunchAgents\/com\.mesaandmoon\.drivebay\.plist/);

  for (const file of [setup, pack, sign, path.join(root, "installer/unix/install.sh")]) {
    const check = spawnSync("bash", ["-n", file], { encoding: "utf8" });
    assert.equal(check.status, 0, `${file}\n${check.stderr}`);
  }
});
