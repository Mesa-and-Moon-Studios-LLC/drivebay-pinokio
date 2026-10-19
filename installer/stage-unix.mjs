/**
 * Packs the standalone server into macOS and Linux tarballs.
 * Node for each target is downloaded and checked against nodejs.org SHASUMS256.
 * The JavaScript bundle is the same on every CPU. Node is the part that differs.
 *
 *   node installer/stage-unix.mjs linux-x64
 *   node installer/stage-unix.mjs all
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const targets = {
  "linux-x64": ["linux", "x64"],
  "linux-arm64": ["linux", "arm64"],
  "darwin-arm64": ["darwin", "arm64"],
  "darwin-x64": ["darwin", "x64"],
};

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const output = path.join(root, "app/.output");
const version = fs.readFileSync(path.join(here, "node-version.txt"), "utf8").trim();
const asked = process.argv[2] || "all";
const names = asked === "all" ? Object.keys(targets) : [asked];

if (!fs.existsSync(path.join(output, "server/index.mjs"))) {
  console.error("Missing app/.output. Build the standalone server first.");
  process.exit(1);
}

async function nodeRuntime(nodeOs, arch, dest) {
  const tarName = `node-v${version}-${nodeOs}-${arch}.tar.gz`;
  const url = `https://nodejs.org/dist/v${version}/${tarName}`;
  console.log(`downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Node download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const sumsResponse = await fetch(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`);
  if (!sumsResponse.ok) throw new Error("Could not download Node SHASUMS256.txt");
  const expected = (await sumsResponse.text())
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.endsWith(tarName));
  if (!expected) throw new Error(`No checksum for ${tarName}`);
  const want = expected.split(/\s+/)[0].toLowerCase();
  const got = crypto.createHash("sha256").update(bytes).digest("hex");
  if (want !== got) throw new Error(`Node tarball checksum mismatch for ${tarName}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-node-"));
  const tarPath = path.join(tmp, tarName);
  fs.writeFileSync(tarPath, bytes);
  execFileSync("tar", ["-xzf", tarPath, "-C", tmp]);
  const extracted = path.join(tmp, `node-v${version}-${nodeOs}-${arch}`);
  fs.cpSync(extracted, dest, { recursive: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}

function stageCommon(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(output, path.join(dir, "app"), { recursive: true });
  for (const name of ["launcher.mjs", "lib.mjs", "reset-password.mjs", "phone-drive.mjs"]) {
    fs.copyFileSync(path.join(here, name), path.join(dir, name));
  }
  fs.copyFileSync(path.join(root, "app/src/lib/files/update-policy.mjs"), path.join(dir, "update-policy.mjs"));
  fs.copyFileSync(path.join(root, "app/src/lib/files/phone-drive.mjs"), path.join(dir, "phone-drive-lib.mjs"));
  fs.copyFileSync(path.join(root, "VERSION.txt"), path.join(dir, "VERSION.txt"));
  fs.copyFileSync(path.join(root, "version-manifest.json"), path.join(dir, "version-manifest.json"));
  fs.copyFileSync(path.join(here, "node-version.txt"), path.join(dir, "node-version.txt"));
  fs.cpSync(path.join(here, "unix"), path.join(dir, "unix"), { recursive: true });
  fs.chmodSync(path.join(dir, "unix/install.sh"), 0o755);
  fs.chmodSync(path.join(dir, "unix/uninstall.sh"), 0o755);
  fs.chmodSync(path.join(dir, "unix/mount-phone.sh"), 0o755);
  fs.chmodSync(path.join(dir, "unix/sign-mac.sh"), 0o755);
}

const dist = path.join(here, "dist");
fs.mkdirSync(dist, { recursive: true });

for (const name of names) {
  const pair = targets[name];
  if (!pair) {
    console.error(`Unknown target ${name}`);
    process.exit(1);
  }
  const dir = path.join(os.tmpdir(), `drivebay-unix-${name}`);
  stageCommon(dir);
  if (process.env.DRIVEBAY_SKIP_NODE !== "1") {
    await nodeRuntime(pair[0], pair[1], path.join(dir, "runtime"));
  }
  fs.writeFileSync(path.join(dir, "target.txt"), name + "\n");
  const archive = path.join(dist, `drivebay-server-${name}.tar.gz`);
  execFileSync("tar", ["-czf", archive, "-C", dir, "."]);
  fs.rmSync(dir, { recursive: true, force: true });
  const info = fs.statSync(archive);
  console.log(`${archive} ${info.size}`);
}
