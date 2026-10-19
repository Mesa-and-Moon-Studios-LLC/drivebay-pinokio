/**
 * Fills installer/staging with the production server, launcher, and official
 * Windows Node binary. The NSIS script packs that folder. Nothing here is
 * committed.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function extractZip(zipPath, dest) {
  const python = [
    "-c",
    "import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])",
    zipPath,
    dest,
  ];
  const attempts = [
    ["unzip", ["-q", zipPath, "-d", dest]],
    ["tar", ["-xf", zipPath, "-C", dest]],
    ["python3", python],
    ["python", python],
  ];
  let last;
  for (const [cmd, args] of attempts) {
    try {
      execFileSync(cmd, args, { stdio: "ignore" });
      return;
    } catch (err) {
      last = err;
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(dest, { recursive: true });
    }
  }
  throw last;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const output = path.join(root, "app/.output");
const staging = path.join(here, "staging");
const version = fs.readFileSync(path.join(here, "node-version.txt"), "utf8").trim();

if (!fs.existsSync(path.join(output, "server/index.mjs"))) {
  console.error("Missing app/.output. Build the standalone server first.");
  process.exit(1);
}
for (const name of ["pglite.wasm", "initdb.wasm", "pglite.data"]) {
  if (!fs.existsSync(path.join(output, "server/_libs", name))) {
    console.error(`Missing ${name}. Run installer/copy-pglite-assets.mjs.`);
    process.exit(1);
  }
}

fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });
fs.cpSync(output, path.join(staging, "app"), { recursive: true });
for (const name of ["launcher.mjs", "lib.mjs", "reset-password.mjs", "phone-drive.mjs", "drivebay.cmd", "start-drivebay.vbs", "stop-drivebay.vbs"]) {
  fs.copyFileSync(path.join(here, name), path.join(staging, name));
}
fs.copyFileSync(path.join(root, "app/src/lib/files/update-policy.mjs"), path.join(staging, "update-policy.mjs"));
fs.copyFileSync(path.join(root, "app/src/lib/files/phone-drive.mjs"), path.join(staging, "phone-drive-lib.mjs"));
fs.copyFileSync(path.join(root, "version-manifest.json"), path.join(staging, "version-manifest.json"));
fs.copyFileSync(path.join(root, "reset-password.ps1"), path.join(staging, "reset-password.ps1"));
const trayExe = path.join(here, "DrivebayTray.exe");
if (!fs.existsSync(trayExe)) {
  console.error("Missing installer/DrivebayTray.exe. Build it with csc before staging.");
  process.exit(1);
}
fs.copyFileSync(trayExe, path.join(staging, "DrivebayTray.exe"));
fs.cpSync(path.join(here, "windows"), path.join(staging, "windows"), { recursive: true });
fs.cpSync(path.join(here, "assets"), path.join(staging, "assets"), { recursive: true });
fs.copyFileSync(path.join(root, "VERSION.txt"), path.join(staging, "VERSION.txt"));

const zipName = `node-v${version}-win-x64.zip`;
const url = `https://nodejs.org/dist/v${version}/${zipName}`;
console.log(`downloading ${url}`);
const response = await fetch(url);
if (!response.ok) {
  console.error(`Node download failed: HTTP ${response.status}`);
  process.exit(1);
}
const bytes = Buffer.from(await response.arrayBuffer());
const sumsResponse = await fetch(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`);
if (!sumsResponse.ok) {
  console.error("Could not download Node SHASUMS256.txt");
  process.exit(1);
}
const sums = await sumsResponse.text();
const expected = sums
  .split(/\r?\n/)
  .map((line) => line.trim())
  .find((line) => line.endsWith(zipName));
if (!expected) {
  console.error(`No checksum for ${zipName}`);
  process.exit(1);
}
const want = expected.split(/\s+/)[0].toLowerCase();
const got = crypto.createHash("sha256").update(bytes).digest("hex");
if (want !== got) {
  console.error(`Node zip checksum mismatch: ${got} != ${want}`);
  process.exit(1);
}
console.log("node zip checksum ok");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-node-"));
const zipPath = path.join(tmp, zipName);
fs.writeFileSync(zipPath, bytes);
const extractDir = path.join(tmp, "extract");
fs.mkdirSync(extractDir, { recursive: true });
extractZip(zipPath, extractDir);
const extracted = path.join(extractDir, `node-v${version}-win-x64`);
const runtime = path.join(staging, "runtime");
fs.mkdirSync(runtime, { recursive: true });
fs.copyFileSync(path.join(extracted, "node.exe"), path.join(runtime, "node.exe"));
fs.copyFileSync(path.join(extracted, "LICENSE"), path.join(runtime, "LICENSE"));
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(path.join(here, "dist"), { recursive: true });
console.log(`staged ${staging}`);
