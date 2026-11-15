import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyPlan,
  followDownload,
  hasExistingInstall,
  installCommand,
  listUnsafeTarEntries,
  payloadKind,
  runApply,
  saveDownload,
} from "../app/src/lib/files/update-apply.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exeUrl =
  "https://github.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/releases/download/v3.36.4/Drivebay-Setup-3.36.4.exe";
const objectUrl = "https://objects.githubusercontent.com/drivebay/Drivebay-Setup-3.36.4.exe";
const tarUrl =
  "https://github.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/releases/download/v3.36.4/drivebay-server-linux-x64.tar.gz";

test("apply plan is a silent Windows installer or a unix tarball, and refuses other urls", () => {
  const windows = applyPlan({
    action: "optional",
    platform: "win-x64",
    fileName: "Drivebay-Setup-3.36.4.exe",
    downloadUrl: exeUrl,
  });
  assert.equal(windows.ok, true);
  assert.equal(windows.kind, "windows-installer");
  assert.deepEqual(windows.args, ["/S"]);
  assert.deepEqual(installCommand(windows, { installer: "C:\\updates\\setup.exe", home: "C:\\Drivebay" }), {
    file: "C:\\updates\\setup.exe",
    args: ["/S"],
    env: {},
  });

  const unix = applyPlan({
    action: "required",
    platform: "linux-x64",
    fileName: "drivebay-server-linux-x64.tar.gz",
    downloadUrl: tarUrl,
  });
  assert.equal(unix.kind, "unix-tarball");
  const command = installCommand(unix, { extractDir: "/tmp/extract", home: "/home/me/.local/share/drivebay" });
  assert.equal(command.file, "bash");
  assert.equal(command.env.DRIVEBAY_HOME, "/home/me/.local/share/drivebay");
  assert.equal(command.env.DRIVEBAY_SOURCE, "/tmp/extract");

  assert.equal(applyPlan({ action: "none" }).reason, "current");
  assert.equal(applyPlan({ action: "optional", fileName: "setup.exe", downloadUrl: "" }).reason, "no-asset");
  assert.equal(
    applyPlan({ action: "optional", platform: "win-x64", fileName: "setup.exe", downloadUrl: "https://evil.example/setup.exe" }).reason,
    "no-asset",
  );
  assert.deepEqual(listUnsafeTarEntries(["launcher.mjs", "/etc/passwd", "../escape", "unix/install.sh"]), ["/etc/passwd", "../escape"]);
  assert.equal(payloadKind("Drivebay-Setup-3.36.4.exe", Buffer.from([0x4d, 0x5a, 0, 0])), "exe");
  assert.equal(payloadKind("drivebay-server-linux-x64.tar.gz", Buffer.from([0x1f, 0x8b])), "gzip");
  assert.equal(payloadKind("Drivebay-Setup-3.36.4.exe", Buffer.from("not-an-exe")), "");
  assert.equal(payloadKind("notes.txt", Buffer.from([0x4d, 0x5a])), "");
});

test("downloads follow GitHub redirects and reject a later host that is not GitHub", async () => {
  const bad = await followDownload(exeUrl, async (url) => {
    if (url === exeUrl) {
      return { status: 302, headers: { get: (name) => (name === "location" ? "https://evil.example/setup.exe" : "") } };
    }
    throw new Error(String(url));
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "url");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-update-"));
  const dest = path.join(dir, "Drivebay-Setup-3.36.4.exe");
  const saved = await saveDownload(exeUrl, dest, async (url) => {
    if (url === exeUrl) {
      return { status: 302, headers: { get: () => objectUrl } };
    }
    return {
      status: 200,
      headers: { get: () => "" },
      arrayBuffer: async () => Uint8Array.from([0x4d, 0x5a, 0x90, 0x00]),
    };
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.kind, "exe");
  assert.equal(fs.readFileSync(dest)[0], 0x4d);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("apply downloads the installer and starts it only when config.json already exists", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-home-"));
  assert.equal(hasExistingInstall(home), false);
  const missing = await runApply({
    home,
    platform: "win-x64",
    versionText: "Drivebay 3.36.3",
    fetchImpl: async () => {
      throw new Error("should not fetch");
    },
    spawnImpl: () => {
      throw new Error("should not spawn");
    },
  });
  assert.equal(missing.reason, "not-installed");

  fs.writeFileSync(path.join(home, "config.json"), '{"mode":"regular","port":8765}\n');
  const spawned = [];
  const started = await runApply({
    home,
    platform: "win-x64",
    versionText: "Drivebay 3.36.3",
    spawnImpl: (file, args) => {
      spawned.push({ file, args });
      return 42;
    },
    fetchImpl: async (url) => {
      const text = String(url);
      if (text.includes("releases/latest")) {
        return {
          ok: true,
          json: async () => ({
            assets: [
              {
                name: "version-manifest.json",
                browser_download_url: "https://github.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/releases/download/v3.36.4/version-manifest.json",
              },
              { name: "Drivebay-Setup-3.36.4.exe", browser_download_url: exeUrl },
            ],
          }),
        };
      }
      if (text.includes("version-manifest.json")) {
        return {
          ok: true,
          text: async () => JSON.stringify({ minimum: "3.36", latest: "3.36.4", message: "Install the latest release." }),
        };
      }
      if (text === exeUrl) return { status: 302, headers: { get: () => objectUrl } };
      return {
        status: 200,
        headers: { get: () => "" },
        arrayBuffer: async () => Uint8Array.from([0x4d, 0x5a, 0x90, 0x00]),
      };
    },
  });
  assert.equal(started.started, true);
  assert.equal(started.kind, "windows-installer");
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].args[0], "/S");
  assert.equal(spawned[0].file.endsWith("Drivebay-Setup-3.36.4.exe"), true);
  fs.rmSync(home, { recursive: true, force: true });

  const unixHome = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-unix-"));
  fs.writeFileSync(path.join(unixHome, "config.json"), '{"mode":"regular","port":8765}\n');
  const unixSpawned = [];
  const unix = await runApply({
    home: unixHome,
    platform: "linux-x64",
    versionText: "Drivebay 3.36.3",
    tarEntries: ["launcher.mjs", "unix/install.sh"],
    spawnImpl: (file, args, spawnEnv) => {
      unixSpawned.push({ file, args, spawnEnv });
      return 7;
    },
    fetchImpl: async (url) => {
      const text = String(url);
      if (text.includes("releases/latest")) {
        return {
          ok: true,
          json: async () => ({
            assets: [
              {
                name: "version-manifest.json",
                browser_download_url:
                  "https://github.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/releases/download/v3.36.4/version-manifest.json",
              },
              { name: "drivebay-server-linux-x64.tar.gz", browser_download_url: tarUrl },
            ],
          }),
        };
      }
      if (text.includes("version-manifest.json")) {
        return {
          ok: true,
          text: async () => JSON.stringify({ minimum: "3.36", latest: "3.36.4", message: "Install the latest release." }),
        };
      }
      if (text === tarUrl) {
        return { status: 302, headers: { get: () => "https://objects.githubusercontent.com/drivebay/server.tar.gz" } };
      }
      return {
        status: 200,
        headers: { get: () => "" },
        arrayBuffer: async () => Uint8Array.from([0x1f, 0x8b, 0x08, 0x00]),
      };
    },
  });
  assert.equal(unix.started, true);
  assert.equal(unix.kind, "unix-tarball");
  assert.equal(unixSpawned[0].file, "bash");
  assert.equal(unixSpawned[0].args[0].endsWith(`${path.sep}unix${path.sep}install.sh`), true);
  assert.equal(unixSpawned[0].spawnEnv.DRIVEBAY_HOME, unixHome);
  assert.equal(unixSpawned[0].spawnEnv.DRIVEBAY_SOURCE.endsWith(`${path.sep}extract`), true);

  const blocked = [];
  const unsafe = await runApply({
    home: unixHome,
    platform: "linux-x64",
    versionText: "Drivebay 3.36.3",
    tarEntries: ["../etc/passwd", "unix/install.sh"],
    spawnImpl: () => {
      blocked.push(true);
      return 1;
    },
    fetchImpl: async (url) => {
      const text = String(url);
      if (text.includes("releases/latest")) {
        return {
          ok: true,
          json: async () => ({
            assets: [
              {
                name: "version-manifest.json",
                browser_download_url:
                  "https://github.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/releases/download/v3.36.4/version-manifest.json",
              },
              { name: "drivebay-server-linux-x64.tar.gz", browser_download_url: tarUrl },
            ],
          }),
        };
      }
      if (text.includes("version-manifest.json")) {
        return {
          ok: true,
          text: async () => JSON.stringify({ minimum: "3.36", latest: "3.36.4", message: "Install the latest release." }),
        };
      }
      return {
        status: 200,
        headers: { get: () => "" },
        arrayBuffer: async () => Uint8Array.from([0x1f, 0x8b, 0x08, 0x00]),
      };
    },
  });
  assert.equal(unsafe.reason, "archive");
  assert.equal(blocked.length, 0);
  fs.rmSync(unixHome, { recursive: true, force: true });

  const tray = fs.readFileSync(path.join(root, "installer/tray/DrivebayTray.cs"), "utf8");
  assert.match(tray, /Update available/);
  assert.match(tray, /update-apply\.mjs/);
  assert.match(fs.readFileSync(path.join(root, "installer/unix/install.sh"), "utf8"), /update-apply\.mjs/);
  assert.match(fs.readFileSync(path.join(root, "installer/stage.mjs"), "utf8"), /update-apply\.mjs/);
  assert.match(fs.readFileSync(path.join(root, "app/src/routes/settings.tsx"), "utf8"), /Check for updates/);
  assert.match(fs.readFileSync(path.join(root, "app/src/components/update-notice.tsx"), "utf8"), /Update available/);
});
