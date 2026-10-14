import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { handleTokenApi } from "../app/src/lib/files/api-v1.mjs";
import { createToken, decideApproval, listPendingApprovals } from "../app/src/lib/files/token-store.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repo, "skills/drivebay/scripts/drivebay.js");

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function serve(ctx) {
  const server = http.createServer(async (req, res) => {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (key === "host" || key === "content-length" || key === "transfer-encoding") continue;
      if (typeof value === "string") headers.set(key, value);
      else if (Array.isArray(value)) headers.set(key, value.join(", "));
    }
    const method = req.method || "GET";
    const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req);
    const request = new Request(`http://127.0.0.1${req.url}`, { method, headers, body });
    const response = await handleTokenApi(request, {
      file: ctx.file,
      roots: async () => [{ id: "root", path: ctx.root, label: "Root" }],
      assertWrite() {},
      now: () => Date.now(),
      ratePerMinute: 1000,
    });
    const payload = Buffer.from(await response.arrayBuffer());
    const out = {};
    response.headers.forEach((value, key) => {
      out[key] = value;
    });
    res.writeHead(response.status, out);
    res.end(payload);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function run(args, env, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 10000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test("the OpenClaw skill declares node, the token env, and no packages", () => {
  const skill = fs.readFileSync(path.join(repo, "skills/drivebay/SKILL.md"), "utf8");
  const card = fs.readFileSync(path.join(repo, "skills/drivebay/skill-card.md"), "utf8");
  const source = fs.readFileSync(script, "utf8");
  const readme = fs.readFileSync(path.join(repo, "README.md"), "utf8");
  assert.match(skill, /"bins": \["node"\]/);
  assert.match(skill, /"env": \["DRIVEBAY_URL", "DRIVEBAY_TOKEN"\]/);
  assert.match(skill, /"primaryEnv": "DRIVEBAY_TOKEN"/);
  assert.match(skill, /openclaw/);
  assert.match(skill, /Waiting for approval on Drivebay/);
  assert.match(skill, /Do not publish this skill or the token to ClawHub/);
  assert.match(card, /Do not publish this skill or a token to ClawHub/);
  assert.match(card, /DRIVEBAY_TOKEN/);
  assert.equal(source.includes("import "), false);
  const required = [...source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]);
  assert.ok(required.length > 0);
  assert.ok(required.every((name) => name.startsWith("node:")));
  assert.equal((source.match(/\bfetch\s*\(/g) || []).length, 1);
  assert.match(source, /redirect:\s*"error"/);
  assert.match(source, /target\.origin !== base\.origin/);
  assert.match(source, /Waiting for approval on Drivebay/);
  assert.match(source, /--yes/);
  assert.match(source, /DRIVEBAY_GET_CONFIRM_BYTES/);
  assert.match(readme, /## API tokens/);
  assert.match(readme, /Do not publish the skill or the token to ClawHub/);
  assert.match(readme, /GET \/api\/v1\/approvals\/<id>/);
  assert.equal(skill.includes("clawhub publish"), false);
});

test("the skill lists roots, asks before a large download, and polls for approval", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-skill-"));
  const root = path.join(dir, "root");
  const work = path.join(dir, "work");
  fs.mkdirSync(root);
  fs.mkdirSync(work);
  const ctx = { dir, root, file: path.join(dir, "api-access.json") };
  const created = createToken(ctx.file, { name: "Skill", roots: [] }, Date.now());
  const remote = path.join(root, "note.txt");
  fs.writeFileSync(remote, "0123456789");
  const api = await serve(ctx);
  const env = {
    DRIVEBAY_URL: api.url,
    DRIVEBAY_TOKEN: created.token,
    DRIVEBAY_APPROVAL_POLL_MS: "40",
  };
  try {
    const roots = await run(["roots"], env, work);
    assert.equal(roots.code, 0, roots.stderr);
    assert.match(roots.stdout, /"roots"/);
    assert.equal(roots.stdout.includes(created.token), false);

    const capped = await run(["get", remote], { ...env, DRIVEBAY_GET_CONFIRM_BYTES: "4" }, work);
    assert.notEqual(capped.code, 0);
    assert.match(capped.stderr, /Download 10 bytes/);
    assert.equal(fs.existsSync(path.join(work, "note.txt")), false);

    const got = await run(["get", remote, "--yes"], { ...env, DRIVEBAY_GET_CONFIRM_BYTES: "4" }, work);
    assert.equal(got.code, 0, got.stderr);
    assert.equal(fs.readFileSync(path.join(work, "note.txt"), "utf8"), "0123456789");

    const local = path.join(work, "up.txt");
    fs.writeFileSync(local, "fresh");
    const clobber = await run(["put", local, remote], env, work);
    assert.notEqual(clobber.code, 0);
    assert.match(clobber.stderr, /Overwrite/);
    assert.equal(fs.readFileSync(remote, "utf8"), "0123456789");

    const folder = path.join(root, "made");
    const pending = run(["mkdir", folder], env, work);
    const started = Date.now();
    let approval = null;
    while (Date.now() - started < 5000) {
      const rows = listPendingApprovals(ctx.file, Date.now());
      if (rows.length) {
        approval = rows[0];
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(approval, "expected a pending approval");
    decideApproval(ctx.file, approval.id, true, 0, Date.now());
    const made = await pending;
    assert.equal(made.code, 0, made.stderr);
    assert.match(made.stderr, /Waiting for approval on Drivebay/);
    assert.equal(fs.statSync(folder).isDirectory(), true);
    assert.equal(made.stdout.includes(created.token), false);
    assert.equal(made.stderr.includes(created.token), false);
  } finally {
    await api.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
