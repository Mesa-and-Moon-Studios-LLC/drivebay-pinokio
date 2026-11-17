/**
 * Runs the PHP license tests (license_test.php and the Enterprise gate_test.php) when php is available.
 * Needs php with ext-sodium, or SODIUM_COMPAT_AUTOLOAD pointing at paragonie/sodium_compat. Skipped otherwise.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tests = path.join(root, "server", "cloud-api", "tests");
const PHP = process.env.PHP_BIN || "php";
const COMPAT = process.env.SODIUM_COMPAT_AUTOLOAD || "";
const probe = spawnSync(PHP, ["-r", "echo function_exists('sodium_crypto_sign_detached') ? 'y' : 'n';"], { encoding: "utf8" });
const skip = probe.error || !(probe.stdout === "y" || (COMPAT && fs.existsSync(COMPAT))) ? "php with sodium (or SODIUM_COMPAT_AUTOLOAD) not available" : false;

for (const file of ["license_test.php", "gate_test.php"]) {
  test(`php ${file}`, { skip }, () => {
    const run = spawnSync(PHP, [path.join(tests, file)], { encoding: "utf8", env: process.env });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /\d+ passed, 0 failed/);
  });
}
