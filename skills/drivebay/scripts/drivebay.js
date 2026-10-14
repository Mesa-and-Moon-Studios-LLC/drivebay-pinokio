#!/usr/bin/env node
/**
 * Drivebay client for OpenClaw.
 * Node.js built-ins only. The only network call goes to DRIVEBAY_URL.
 */
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { setTimeout: delay } = require("node:timers/promises");

const DEFAULT_CAP = 20 * 1024 * 1024;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function baseUrl() {
  const raw = process.env.DRIVEBAY_URL;
  if (!raw) fail("DRIVEBAY_URL is required");
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail("DRIVEBAY_URL is not a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") fail("DRIVEBAY_URL must be http or https");
  if (url.username || url.password) fail("DRIVEBAY_URL cannot include a password");
  return url;
}

function bearer() {
  const value = process.env.DRIVEBAY_TOKEN;
  if (!value) fail("DRIVEBAY_TOKEN is required");
  return value;
}

function endpoint(pathname, query) {
  const base = baseUrl();
  const target = new URL(pathname, `${base.origin}/`);
  if (target.origin !== base.origin) fail("Refusing to call a different host");
  if (!target.pathname.startsWith("/api/v1/")) fail("Refusing to call a different path");
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value != null && value !== "") target.searchParams.set(key, String(value));
    }
  }
  if (target.origin !== base.origin) fail("Refusing to call a different host");
  return target;
}

async function api(pathname, options = {}) {
  const target = endpoint(pathname, options.query);
  const headers = { authorization: `Bearer ${bearer()}` };
  if (options.headers) Object.assign(headers, options.headers);
  if (options.approval) headers["x-drivebay-approval"] = options.approval;
  try {
    return await fetch(target, {
      method: options.method || "GET",
      headers,
      body: options.body,
      redirect: "error",
    });
  } catch (err) {
    fail(err && err.message ? err.message : "Drivebay did not answer");
  }
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 200) || "Drivebay returned an unexpected response" };
  }
}

function pollMs() {
  const raw = Number(process.env.DRIVEBAY_APPROVAL_POLL_MS || 2000);
  if (!Number.isFinite(raw) || raw < 50) return 2000;
  return raw;
}

async function confirm(question) {
  process.stderr.write(`${question}\n`);
  if (!process.stdin.isTTY) {
    process.stderr.write("Re-run with --yes after you agree.\n");
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise((resolve) => {
    rl.question("Type yes to continue: ", resolve);
  });
  rl.close();
  return /^y(es)?$/i.test(String(answer).trim());
}

async function withApproval(run) {
  const first = await run();
  if (first.status !== 403) return first;
  const body = await readJson(first);
  if (!body.approval_request_id) fail(body.error || "Drivebay refused the request");
  process.stderr.write("Waiting for approval on Drivebay\n");
  const deadline = Date.now() + 11 * 60 * 1000;
  while (Date.now() < deadline) {
    await delay(pollMs());
    const poll = await api(`/api/v1/approvals/${encodeURIComponent(body.approval_request_id)}`);
    const status = await readJson(poll);
    if (status.status === "approved") return run(body.approval_request_id);
    if (status.status === "denied" || status.status === "expired" || status.status === "used") {
      fail(`Drivebay ${status.status} the request`);
    }
    if (poll.status === 404) fail("Drivebay could not find the request");
  }
  fail("The approval request expired");
}

function parseArgs(argv) {
  const yes = argv.includes("--yes");
  const args = [];
  let out = "";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--yes") continue;
    if (arg === "--out") {
      out = argv[i + 1] || "";
      i += 1;
      continue;
    }
    args.push(arg);
  }
  return { yes, out, cmd: args[0] || "", rest: args.slice(1) };
}

async function printJson(response) {
  const body = await readJson(response);
  if (response.status < 200 || response.status >= 300) fail(body.error || "Drivebay refused the request");
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
}

async function statPath(remote) {
  const response = await api("/api/v1/stat", { query: { path: remote } });
  const body = await readJson(response);
  return { response, body };
}

async function getFile(remote, out, yes) {
  if (!remote) fail("get needs a path");
  const found = await statPath(remote);
  if (found.response.status !== 200) fail(found.body.error || "Could not read the file");
  const cap = Number(process.env.DRIVEBAY_GET_CONFIRM_BYTES || DEFAULT_CAP);
  if (typeof found.body.size === "number" && found.body.size > cap && !yes) {
    const ok = await confirm(`Download ${found.body.size} bytes from ${remote}?`);
    if (!ok) process.exit(1);
  }
  const dest = out || path.basename(remote);
  if (fs.existsSync(dest) && !yes) {
    const ok = await confirm(`Overwrite ${dest}?`);
    if (!ok) process.exit(1);
  }
  const response = await api("/api/v1/download", { query: { path: remote } });
  if (response.status !== 200 && response.status !== 206) {
    const body = await readJson(response);
    fail(body.error || "Download failed");
  }
  fs.writeFileSync(dest, Buffer.from(await response.arrayBuffer()));
  process.stdout.write(`${dest}\n`);
}

async function putFile(local, remote, yes) {
  if (!local || !remote) fail("put needs a local file and a remote path");
  const bytes = fs.readFileSync(local);
  const found = await statPath(remote);
  const exists = found.response.status === 200;
  if (exists && !yes) {
    const ok = await confirm(`Overwrite ${remote}?`);
    if (!ok) process.exit(1);
  }
  const response = await withApproval((approval) =>
    api("/api/v1/upload", {
      method: "PUT",
      query: { path: remote, overwrite: exists ? "1" : "", approval },
      body: bytes,
      approval,
      headers: { "content-type": "application/octet-stream" },
    }),
  );
  const body = await readJson(response);
  if (response.status !== 200) fail(body.error || "Upload failed");
  process.stdout.write(`${body.path}\n`);
}

async function writeJson(pathname, payload, approval) {
  return api(pathname, {
    method: "POST",
    query: approval ? { approval } : undefined,
    approval,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function main() {
  const { yes, out, cmd, rest } = parseArgs(process.argv.slice(2));
  if (cmd === "roots") {
    await printJson(await api("/api/v1/roots"));
    return;
  }
  if (cmd === "ls") {
    await printJson(await api("/api/v1/list", { query: { path: rest[0] || "" } }));
    return;
  }
  if (cmd === "stat") {
    await printJson(await api("/api/v1/stat", { query: { path: rest[0] || "" } }));
    return;
  }
  if (cmd === "find") {
    await printJson(await api("/api/v1/search", { query: { path: rest[0] || "", q: rest.slice(1).join(" ") } }));
    return;
  }
  if (cmd === "get") {
    await getFile(rest[0] || "", out, yes);
    return;
  }
  if (cmd === "put") {
    await putFile(rest[0] || "", rest[1] || "", yes);
    return;
  }
  if (cmd === "mkdir") {
    const response = await withApproval((approval) => writeJson("/api/v1/mkdir", { path: rest[0] || "" }, approval));
    await printJson(response);
    return;
  }
  if (cmd === "mv") {
    const response = await withApproval((approval) =>
      writeJson("/api/v1/rename", { path: rest[0] || "", name: rest[1] || "" }, approval),
    );
    await printJson(response);
    return;
  }
  if (cmd === "rm") {
    const response = await withApproval((approval) => writeJson("/api/v1/delete", { path: rest[0] || "" }, approval));
    await printJson(response);
    return;
  }
  fail("Commands: roots, ls, stat, find, get, put, mkdir, mv, rm");
}

main();
