/**
 * Local-only Drivebay password reset.
 * `drivebay reset-password` prompts on this PC. It never takes the password
 * as an argument, and it never resets an account over HTTP.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { timingSafeEqual } from "node:crypto";
import { Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function coreModuleUrl() {
  const candidates = [
    path.join(here, "../app/src/lib/auth/reset-password.mjs"),
    path.join(here, "app/src/lib/auth/reset-password.mjs"),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) return pathToFileURL(file).href;
  }
  return null;
}

async function loadCore() {
  const url = coreModuleUrl();
  if (!url) throw new Error("Drivebay's password reset program is missing.");
  return import(url);
}

function pgliteEntry() {
  const candidates = [
    path.join(here, "../app/node_modules/@electric-sql/pglite/dist/index.js"),
    path.join(here, "app/node_modules/@electric-sql/pglite/dist/index.js"),
    path.join(here, "vendor/pglite/dist/index.js"),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) return pathToFileURL(file).href;
  }
  return null;
}

export function serverEntryPath() {
  return path.join(here, "app", "server", "index.mjs");
}

export function assertLocalReset(argv, env = process.env) {
  const args = argv.filter((arg) => arg !== "reset-password");
  for (const arg of args) {
    const text = String(arg);
    if (text === "--stdin") continue;
    throw new Error("Type the new password when asked. Drivebay does not take it as an argument.");
  }
  if (String(env.DRIVEBAY_NEW_PASSWORD || "").trim()) {
    throw new Error("Type the new password when asked. Drivebay does not take it from the environment.");
  }
  if (String(env.DATABASE_URL || "").trim()) {
    throw new Error("Password reset only changes the account database on this PC.");
  }
}

export function checkTypedPassword(password) {
  const value = String(password ?? "");
  if (value.length < 8) return { ok: false, reason: "Use at least 8 characters." };
  if (value.length > 256) return { ok: false, reason: "Use at most 256 characters." };
  if (value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    return { ok: false, reason: "The password must be a single line." };
  }
  return { ok: true, password: value };
}

export function sameTypedPassword(left, right) {
  const a = Buffer.from(String(left ?? ""), "utf8");
  const b = Buffer.from(String(right ?? ""), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function askHidden(question) {
  return new Promise((resolve) => {
    const muted = new Writable({
      write(chunk, _encoding, callback) {
        const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        if (text.includes("\n") || text.includes("\r")) process.stdout.write("\n");
        callback();
      },
    });
    const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
    process.stdout.write(question);
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function promptTwice() {
  const first = await askHidden("New password: ");
  const second = await askHidden("Type it again: ");
  if (!sameTypedPassword(first, second)) return { ok: false, reason: "Those passwords do not match." };
  return checkTypedPassword(first);
}

async function readStdinLine(stdin) {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/, 1)[0] ?? "";
}

export async function openDrivebayDatabase(dataDir) {
  const entry = pgliteEntry();
  if (!entry) throw new Error("Drivebay cannot open its local database from this copy.");
  const { PGlite } = await import(entry);
  const pg = new PGlite({ dataDir: dataDir.replace(/\\/g, "/"), relaxedDurability: true });
  await pg.waitReady;
  return {
    query: async (text, params = []) => {
      const result = await pg.query(text, params);
      return result.rows ?? [];
    },
    exec: async (text) => {
      await pg.exec(text);
    },
    close: async () => {
      await pg.close();
    },
  };
}

function resultPath(home) {
  return path.join(home, "reset-result.json");
}

function readResultFile(home, password) {
  const file = resultPath(home);
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { ok: false, reason: "Password reset failed." };
  } finally {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* already gone */
    }
  }
  if (password && text.includes(password)) return { ok: false, reason: "Password reset failed." };
  try {
    const parsed = JSON.parse(text);
    return {
      ok: Boolean(parsed.ok),
      username: parsed.ok ? String(parsed.username ?? "") : "",
      reason: parsed.ok ? "" : String(parsed.reason || "Password reset failed."),
    };
  } catch {
    return { ok: false, reason: "Password reset failed." };
  }
}

function resetThroughServer(home, entry, password, nodePath) {
  return new Promise((resolve) => {
    try {
      fs.rmSync(resultPath(home), { force: true });
    } catch {
      /* none yet */
    }
    const env = {
      ...process.env,
      DRIVEBAY_STANDALONE: "true",
      DRIVEBAY_HOME: home,
      DRIVEBAY_DATA_DIR: path.join(home, "data"),
      DRIVEBAY_RESET_PASSWORD: "1",
      HOST: "127.0.0.1",
      NITRO_HOST: "127.0.0.1",
      PORT: "0",
    };
    delete env.DATABASE_URL;
    delete env.DRIVEBAY_NEW_PASSWORD;
    const child = spawn(nodePath || process.execPath, [entry], {
      cwd: path.dirname(path.dirname(entry)),
      windowsHide: true,
      stdio: ["pipe", "ignore", "ignore"],
      env,
    });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.on("error", () => finish({ ok: false, reason: "Password reset failed." }));
    child.on("exit", () => finish(readResultFile(home, password)));
    child.stdin.write(`${password}\n`);
    child.stdin.end();
    setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      finish({ ok: false, reason: "Password reset failed." });
    }, 120_000).unref?.();
  });
}

async function resetThroughDatabase(home, password) {
  const dataDir = path.join(home, "data");
  if (!fs.existsSync(dataDir)) return { ok: false, reason: "No Drivebay account is saved on this PC." };
  const core = await loadCore();
  const db = await openDrivebayDatabase(dataDir);
  try {
    return core.publicResetResult(await core.resetCredentialPassword(db, password));
  } finally {
    await db.close();
  }
}

function safeLog(log, message, password) {
  if (!log) return;
  if (password && message.includes(password)) return;
  log(message);
}

/**
 * @param {{
 *   home: string,
 *   argv?: string[],
 *   env?: NodeJS.ProcessEnv,
 *   stdin?: NodeJS.ReadableStream,
 *   stderr?: NodeJS.WritableStream,
 *   wasRunning?: boolean,
 *   serverEntry?: string | null,
 *   nodePath?: string,
 *   stop?: () => Promise<void> | void,
 *   log?: (message: string) => void,
 *   rotateSecret?: () => void,
 *   shredPending?: () => void,
 *   startAgain?: () => void,
 * }} options
 */
export async function runResetCommand(options) {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const stderr = options.stderr ?? process.stderr;
  const home = options.home;
  let password = "";
  try {
    assertLocalReset(argv, env);
    const stdinMode = argv.includes("--stdin");
    if (stdinMode) {
      const checked = checkTypedPassword(await readStdinLine(options.stdin ?? process.stdin));
      if (!checked.ok) {
        stderr.write(`${checked.reason}\n`);
        return 1;
      }
      password = checked.password;
    } else if (!process.stdin.isTTY) {
      stderr.write("Run this on this PC and type the new password when asked.\n");
      return 1;
    } else {
      const prompted = await promptTwice();
      if (!prompted.ok) {
        stderr.write(`${prompted.reason}\n`);
        return 1;
      }
      password = prompted.password;
    }

    if (options.stop) await options.stop();
    const entry = options.serverEntry === undefined ? serverEntryPath() : options.serverEntry;
    const result =
      entry && fs.existsSync(entry)
        ? await resetThroughServer(home, entry, password, options.nodePath)
        : await resetThroughDatabase(home, password);
    if (!result.ok) {
      const reason = result.reason || "Password reset failed.";
      safeLog(options.log, reason, password);
      stderr.write(`${reason}\n`);
      return 1;
    }
    try {
      options.rotateSecret?.();
    } catch {
      /* the password is already changed; sessions were deleted */
    }
    try {
      options.shredPending?.();
    } catch {
      /* the setup file may already be gone */
    }
    const message = `Password updated for ${result.username}. Sign in again on every device. Settings, drives, and API tokens were kept.`;
    safeLog(options.log, message, password);
    stderr.write(`${message}\n`);
    if (options.wasRunning) {
      try {
        options.startAgain?.();
      } catch {
        stderr.write("Start Drivebay again, then sign in with the new password.\n");
      }
    }
    return 0;
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Password reset failed.";
    const safe = password && reason.includes(password) ? "Password reset failed." : reason;
    safeLog(options.log, safe, password);
    stderr.write(`${safe}\n`);
    return 1;
  } finally {
    password = "";
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const home = process.env.DRIVEBAY_HOME
    ? path.resolve(process.env.DRIVEBAY_HOME)
    : path.join(
        process.env.LOCALAPPDATA || path.join(process.env.HOME || "", ".local", "share"),
        "Drivebay",
      );
  runResetCommand({ home, argv: process.argv.slice(2) }).then(
    (code) => process.exit(code),
    () => process.exit(1),
  );
}
