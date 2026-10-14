import assert from "node:assert/strict";
import fs from "node:fs";
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { handleTokenApi } from "../app/src/lib/files/api-v1.mjs";
import { wantsJsonError } from "../app/src/lib/files/document-request.mjs";
import {
  APPROVAL_TTL_MS,
  allowWrite,
  createToken,
  decideApproval,
  panelFor,
  readApiAccess,
  resetRateLimits,
  revokeToken,
} from "../app/src/lib/files/token-store.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-api-"));
  const root = path.join(dir, "root");
  fs.mkdirSync(root);
  return { dir, root, file: path.join(dir, "api-access.json"), now: 1_700_000_000_000 };
}

function cleanup(ctx) {
  fs.rmSync(ctx.dir, { recursive: true, force: true });
}

async function samePath(actual, expected) {
  // fs.realpathSync leaves Windows 8.3 names alone. The API uses fs.promises.realpath, which expands them.
  assert.equal(await realpath(actual), await realpath(expected));
}

async function call(ctx, pathname, opts = {}) {
  const headers = new Headers(opts.headers || {});
  if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
  const request = new Request(`http://127.0.0.1${pathname}`, {
    method: opts.method || "GET",
    headers,
    body: opts.body,
  });
  return handleTokenApi(request, {
    file: ctx.file,
    roots: async () => [{ id: "root", path: opts.drive || ctx.root, label: "Root" }],
    assertWrite: opts.assertWrite || (() => {}),
    now: () => ctx.now,
    ratePerMinute: opts.ratePerMinute || 1000,
    maxUploadBytes: opts.maxUploadBytes,
  });
}

test("a token is shown once and only its hash is stored", () => {
  const ctx = temp();
  try {
    const created = createToken(ctx.file, { name: "Claw", roots: [] }, ctx.now);
    assert.match(created.token, /^db_[0-9a-f]{64}$/);
    assert.equal(Buffer.from(created.token.slice(3), "hex").length, 32);
    assert.equal(created.record.prefix, created.token.slice(0, 11));
    const raw = fs.readFileSync(ctx.file, "utf8");
    assert.equal(raw.includes(created.token), false);
    assert.equal(raw.includes(created.record.prefix), true);
    const stored = readApiAccess(ctx.file).tokens[0];
    assert.equal(stored.hash.length, 64);
    assert.equal(Object.hasOwn(stored, "token"), false);
    assert.deepEqual(stored.scope, ["roots", "list", "stat", "search", "download", "thumb"]);
  } finally {
    cleanup(ctx);
  }
});

test("bearer reads stay inside the root and record last use", async () => {
  const ctx = temp();
  try {
    fs.writeFileSync(path.join(ctx.root, "note.txt"), "hello");
    fs.mkdirSync(path.join(ctx.root, "folder"));
    const { token } = createToken(ctx.file, { name: "Read", roots: [] }, ctx.now);
    const missing = await call(ctx, "/api/v1/roots");
    assert.equal(missing.status, 401);

    const roots = await call(ctx, "/api/v1/roots", { token });
    assert.equal(roots.status, 200);
    const rootBody = await roots.json();
    await samePath(rootBody.roots[0].path, ctx.root);

    const listed = await call(ctx, `/api/v1/list?path=${encodeURIComponent(ctx.root)}`, { token });
    const listBody = await listed.json();
    assert.equal(listed.status, 200);
    assert.equal(listBody.entries.some((entry) => entry.name === "note.txt" && entry.kind === "file"), true);

    const st = await call(ctx, `/api/v1/stat?path=${encodeURIComponent(path.join(ctx.root, "note.txt"))}`, { token });
    const statBody = await st.json();
    assert.equal(statBody.kind, "file");
    assert.equal(statBody.size, 5);

    const found = await call(ctx, `/api/v1/search?path=${encodeURIComponent(ctx.root)}&q=note`, { token });
    const searchBody = await found.json();
    assert.equal(searchBody.hits.some((hit) => hit.name === "note.txt"), true);

    const file = await call(ctx, `/api/v1/download?path=${encodeURIComponent(path.join(ctx.root, "note.txt"))}`, { token });
    assert.equal(file.status, 200);
    assert.equal(await file.text(), "hello");
    assert.match(file.headers.get("accept-ranges"), /bytes/);

    const ranged = await call(ctx, `/api/v1/download?path=${encodeURIComponent(path.join(ctx.root, "abcdefghij.txt"))}`, {
      token,
    });
    fs.writeFileSync(path.join(ctx.root, "abcdefghij.txt"), "abcdefghij");
    const part = await call(ctx, `/api/v1/download?path=${encodeURIComponent(path.join(ctx.root, "abcdefghij.txt"))}`, {
      token,
      headers: { range: "bytes=2-5" },
    });
    assert.equal(part.status, 206);
    assert.equal(await part.text(), "cdef");
    assert.equal(part.headers.get("content-range"), "bytes 2-5/10");

    const openEnd = await call(ctx, `/api/v1/download?path=${encodeURIComponent(path.join(ctx.root, "abcdefghij.txt"))}`, {
      token,
      headers: { range: "bytes=7-" },
    });
    assert.equal(openEnd.status, 206);
    assert.equal(await openEnd.text(), "hij");

    const suffix = await call(ctx, `/api/v1/download?path=${encodeURIComponent(path.join(ctx.root, "abcdefghij.txt"))}`, {
      token,
      headers: { range: "bytes=-3" },
    });
    assert.equal(suffix.status, 206);
    assert.equal(await suffix.text(), "hij");

    const bad = await call(ctx, `/api/v1/download?path=${encodeURIComponent(path.join(ctx.root, "abcdefghij.txt"))}`, {
      token,
      headers: { range: "bytes=20-21" },
    });
    assert.equal(bad.status, 416);
    assert.equal(ranged.status, 404);

    const textThumb = await call(ctx, `/api/v1/thumb?path=${encodeURIComponent(path.join(ctx.root, "note.txt"))}`, { token });
    assert.equal(textThumb.status, 415);
    const png = path.join(ctx.root, "pic.png");
    fs.writeFileSync(png, Buffer.from([1, 2, 3, 4]));
    const thumb = await call(ctx, `/api/v1/thumb?path=${encodeURIComponent(png)}`, { token });
    assert.equal(thumb.status, 200);
    assert.equal(thumb.headers.get("content-type"), "image/png");
    const huge = path.join(ctx.root, "big.png");
    fs.writeFileSync(huge, Buffer.alloc(2 * 1024 * 1024 + 1));
    const tooBig = await call(ctx, `/api/v1/thumb?path=${encodeURIComponent(huge)}`, { token });
    assert.equal(tooBig.status, 413);

    const view = readApiAccess(ctx.file).tokens[0];
    assert.equal(view.lastUsedAt, ctx.now);
    const audit = readApiAccess(ctx.file).audit;
    assert.equal(audit.some((entry) => entry.action === "roots" && entry.status === 200), true);
    assert.equal(JSON.stringify(audit).includes(token), false);
    assert.equal(JSON.stringify(readApiAccess(ctx.file)).includes(token), false);
  } finally {
    cleanup(ctx);
  }
});

test("a path outside the root is refused, including a symlink", async (t) => {
  const ctx = temp();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-outside-"));
  const sentinel = "sentinel-outside-secret";
  try {
    fs.writeFileSync(path.join(outside, "secret.txt"), sentinel);
    fs.writeFileSync(path.join(ctx.dir, "secret.txt"), sentinel);
    const { token } = createToken(ctx.file, { name: "Read", roots: [] }, ctx.now);
    const climbed = await call(ctx, `/api/v1/download?path=${encodeURIComponent(path.join(ctx.root, "..", "secret.txt"))}`, { token });
    assert.equal(climbed.status, 403);
    const climbedText = await climbed.text();
    assert.equal(climbedText.includes(sentinel), false);
    assert.equal(climbedText.includes("secret.txt"), false);
    assert.equal(JSON.parse(climbedText).error, "Path is outside the allowed roots.");

    const sibling = path.join(ctx.root + "-extra", "nope.txt");
    const escaped = await call(ctx, `/api/v1/download?path=${encodeURIComponent(sibling)}`, { token });
    assert.equal(escaped.status, 403);

    const link = path.join(ctx.root, "escape");
    try {
      fs.symlinkSync(outside, link, "dir");
    } catch (err) {
      t.skip(`symlink not available: ${err.message}`);
      return;
    }
    const viaLink = await call(ctx, `/api/v1/download?path=${encodeURIComponent(path.join(link, "secret.txt"))}`, { token });
    assert.equal(viaLink.status, 403);
    const viaText = await viaLink.text();
    assert.equal(viaText.includes(sentinel), false);
    assert.equal(viaText.includes(outside), false);

    const listed = await call(ctx, `/api/v1/list?path=${encodeURIComponent(ctx.root)}`, { token });
    const listedText = JSON.stringify(await listed.json());
    assert.equal(listedText.includes(outside), false);
    assert.equal(listedText.includes(sentinel), false);
  } finally {
    cleanup(ctx);
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("a symlink alias of the root still reads the real folder", async (t) => {
  const ctx = temp();
  try {
    fs.writeFileSync(path.join(ctx.root, "note.txt"), "hello");
    const alias = path.join(ctx.dir, "alias");
    try {
      fs.symlinkSync(ctx.root, alias, "dir");
    } catch (err) {
      t.skip(`symlink not available: ${err.message}`);
      return;
    }
    const { token } = createToken(ctx.file, { name: "Alias", roots: [] }, ctx.now);
    const viaAlias = await call(ctx, `/api/v1/download?path=${encodeURIComponent(path.join(alias, "note.txt"))}`, {
      token,
      drive: alias,
    });
    assert.equal(viaAlias.status, 200);
    assert.equal(await viaAlias.text(), "hello");
    const roots = await call(ctx, "/api/v1/roots", { token, drive: alias });
    const body = await roots.json();
    await samePath(body.roots[0].path, ctx.root);
  } finally {
    cleanup(ctx);
  }
});

test("an optional root allowlist narrows reads", async () => {
  const ctx = temp();
  try {
    const only = path.join(ctx.root, "only");
    fs.mkdirSync(only);
    fs.writeFileSync(path.join(only, "ok.txt"), "visible");
    fs.writeFileSync(path.join(ctx.root, "secret.txt"), "hidden");
    const { token } = createToken(ctx.file, { name: "Narrow", roots: [only] }, ctx.now);
    const denied = await call(ctx, `/api/v1/download?path=${encodeURIComponent(path.join(ctx.root, "secret.txt"))}`, { token });
    assert.equal(denied.status, 403);
    assert.equal((await denied.text()).includes("hidden"), false);
    const allowed = await call(ctx, `/api/v1/download?path=${encodeURIComponent(path.join(only, "ok.txt"))}`, { token });
    assert.equal(allowed.status, 200);
    assert.equal(await allowed.text(), "visible");
    const roots = await call(ctx, "/api/v1/roots", { token });
    const body = await roots.json();
    assert.equal(body.roots.length, 1);
    await samePath(body.roots[0].path, only);
  } finally {
    cleanup(ctx);
  }
});

test("expired and revoked tokens stop working, and calls are rate limited", async () => {
  const ctx = temp();
  try {
    resetRateLimits();
    const { token } = createToken(ctx.file, { name: "Short", expiresAt: ctx.now + 1000, roots: [] }, ctx.now);
    const ok = await call(ctx, "/api/v1/roots", { token, ratePerMinute: 2 });
    assert.equal(ok.status, 200);
    const again = await call(ctx, "/api/v1/roots", { token, ratePerMinute: 2 });
    assert.equal(again.status, 200);
    const limited = await call(ctx, "/api/v1/roots", { token, ratePerMinute: 2 });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);

    resetRateLimits();
    ctx.now += 1000;
    const expired = await call(ctx, "/api/v1/roots", { token });
    assert.equal(expired.status, 401);

    const live = createToken(ctx.file, { name: "Live", roots: [] }, ctx.now);
    revokeToken(ctx.file, live.record.id);
    const gone = await call(ctx, "/api/v1/roots", { token: live.token });
    assert.equal(gone.status, 401);
    const wrong = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
    const mismatch = await call(ctx, "/api/v1/roots", { token: wrong });
    assert.equal(mismatch.status, 401);
  } finally {
    cleanup(ctx);
  }
});

test("token management stays on this PC", () => {
  const ctx = temp();
  try {
    createToken(ctx.file, { name: "Desk", roots: [ctx.root] }, ctx.now);
    const quiet = panelFor(ctx.file, { loopback: false, tailnet: false }, ctx.now);
    assert.equal(quiet.canManage, false);
    assert.equal(quiet.canWriteWindow, false);
    assert.equal(quiet.tokens.length, 0);
    const tail = panelFor(ctx.file, { loopback: false, tailnet: true }, ctx.now);
    assert.equal(tail.canWriteWindow, true);
    assert.equal(tail.canManage, false);
    assert.equal(tail.tokens[0].name, "Desk");
    assert.equal(tail.tokens[0].roots, undefined);
    assert.equal(tail.audit.length, 0);
    assert.equal(tail.approvals.length, 0);
    const pc = panelFor(ctx.file, { loopback: true, tailnet: false }, ctx.now);
    assert.equal(pc.canManage, true);
    assert.equal(pc.canWriteWindow, true);
    assert.deepEqual(pc.tokens[0].roots, [ctx.root]);
    assert.equal(pc.tokens[0].name, "Desk");
  } finally {
    cleanup(ctx);
  }

  const api = fs.readFileSync(path.join(repo, "app/src/lib/files/api.functions.ts"), "utf8");
  const create = api.slice(api.indexOf("export const createApiToken"), api.indexOf("export const revokeApiToken"));
  assert.match(create, /assertLoopbackRequest/);
  assert.equal(create.includes("assertPublicAccessEditor"), false);
  const revoke = api.slice(api.indexOf("export const revokeApiToken"), api.indexOf("export const allowApiWrite"));
  assert.match(revoke, /assertLoopbackRequest/);
  assert.equal(revoke.includes("assertPublicAccessEditor"), false);
  const allow = api.slice(api.indexOf("export const allowApiWrite"), api.indexOf("export const decideApiApproval"));
  assert.match(allow, /assertPublicAccessEditor/);
  assert.equal(allow.includes("assertLoopbackRequest"), false);
  const decide = api.slice(api.indexOf("export const decideApiApproval"));
  assert.match(decide, /assertLoopbackRequest/);
  assert.equal(decide.includes("assertPublicAccessEditor"), false);
  const access = api.slice(api.indexOf("export const getApiAccess"), api.indexOf("export const createApiToken"));
  assert.equal(access.includes("assertLoopbackRequest"), false);
  assert.match(access, /isLoopbackRequest/);

  const settings = fs.readFileSync(path.join(repo, "app/src/routes/settings.tsx"), "utf8");
  assert.match(settings, /<ApiTokens \/>/);
  const ui = fs.readFileSync(path.join(repo, "app/src/components/settings/api-tokens.tsx"), "utf8");
  assert.match(ui, /Copy this token now/);
  assert.match(ui, /Audit log/);
  assert.match(ui, /setInterval/);
  assert.match(ui, /API tokens are created on this PC/);
  assert.match(ui, /Allow write for/);
  assert.match(ui, /waiting/);
  assert.match(ui, /signed-in Tailscale device can open a write window/);
});

test("the v1 route is registered and API paths stay JSON", () => {
  const route = fs.readFileSync(path.join(repo, "app/src/routes/api/v1/$.ts"), "utf8");
  const tree = fs.readFileSync(path.join(repo, "app/src/routeTree.gen.ts"), "utf8");
  const server = fs.readFileSync(path.join(repo, "app/src/lib/files/api-v1.server.ts"), "utf8");
  assert.match(route, /createFileRoute\("\/api\/v1\/\$"\)/);
  assert.match(route, /handleApiV1/);
  assert.match(tree, /\/api\/v1\/\$/);
  assert.match(server, /listEnabledDrives/);
  assert.match(server, /assertPolicy/);
  assert.match(server, /assertUploadSize/);
  assert.match(server, /allowedRoots/);
  assert.match(server, /api-access\.json/);
  assert.equal(wantsJsonError("/api/v1/download", ""), true);
  assert.equal(wantsJsonError("/api/v1/roots", null), true);
});

test("writes need an open window and still obey the server lock", async (t) => {
  const ctx = temp();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "drivebay-write-out-"));
  try {
    const { token, record } = createToken(ctx.file, { name: "Writer", roots: [] }, ctx.now);
    const folder = path.join(ctx.root, "made");
    const closed = await call(ctx, "/api/v1/mkdir", {
      token,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: folder }),
    });
    assert.equal(closed.status, 403);
    const closedBody = await closed.json();
    assert.equal(closedBody.error, "Write access is off until this PC approves it.");
    assert.equal(typeof closedBody.approval_request_id, "string");
    assert.equal(fs.existsSync(folder), false);

    allowWrite(ctx.file, record.id, 15, ctx.now);
    const opened = await call(ctx, "/api/v1/mkdir", {
      token,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: folder }),
    });
    assert.equal(opened.status, 200);
    assert.equal(fs.statSync(folder).isDirectory(), true);

    const nested = path.join(folder, "missing-parent", "child");
    const oneLevel = await call(ctx, "/api/v1/mkdir", {
      token,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: nested }),
    });
    assert.equal(oneLevel.status, 404);
    assert.equal(fs.existsSync(path.join(folder, "missing-parent")), false);

    const file = path.join(ctx.root, "note.txt");
    const upload = await call(ctx, `/api/v1/upload?path=${encodeURIComponent(file)}`, {
      token,
      method: "PUT",
      body: "hello",
    });
    assert.equal(upload.status, 200);
    assert.equal(fs.readFileSync(file, "utf8"), "hello");
    const again = await call(ctx, `/api/v1/upload?path=${encodeURIComponent(file)}`, {
      token,
      method: "PUT",
      body: "nope",
    });
    assert.equal(again.status, 409);
    assert.equal(fs.readFileSync(file, "utf8"), "hello");
    const replaced = await call(ctx, `/api/v1/upload?path=${encodeURIComponent(file)}&overwrite=1`, {
      token,
      method: "PUT",
      body: "next",
    });
    assert.equal(replaced.status, 200);
    assert.equal(fs.readFileSync(file, "utf8"), "next");

    const renamed = await call(ctx, "/api/v1/rename", {
      token,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: file, name: "renamed.txt" }),
    });
    assert.equal(renamed.status, 200);
    const renamedPath = path.join(ctx.root, "renamed.txt");
    assert.equal(fs.readFileSync(renamedPath, "utf8"), "next");

    const locked = await call(ctx, "/api/v1/delete", {
      token,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: renamedPath }),
      assertWrite: () => {
        throw new Error("This action is turned off in Settings on the PC that runs Drivebay.");
      },
    });
    assert.equal(locked.status, 403);
    const lockedBody = await locked.json();
    assert.match(lockedBody.error, /turned off/);
    assert.equal(Object.hasOwn(lockedBody, "approval_request_id"), false);
    assert.equal(fs.existsSync(renamedPath), true);

    ctx.now += 15 * 60 * 1000;
    const ended = await call(ctx, "/api/v1/delete", {
      token,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: renamedPath }),
    });
    assert.equal(ended.status, 403);
    const endedBody = await ended.json();
    assert.equal(endedBody.error, "Write access is off until this PC approves it.");
    assert.equal(typeof endedBody.approval_request_id, "string");
    assert.equal(fs.existsSync(renamedPath), true);

    allowWrite(ctx.file, record.id, 60, ctx.now);
    const link = path.join(ctx.root, "escape");
    fs.writeFileSync(path.join(outside, "secret.txt"), "keep");
    try {
      fs.symlinkSync(outside, link, "dir");
    } catch (err) {
      t.skip(`symlink not available: ${err.message}`);
      return;
    }
    const viaLink = await call(ctx, `/api/v1/upload?path=${encodeURIComponent(path.join(link, "secret.txt"))}&overwrite=1`, {
      token,
      method: "PUT",
      body: "changed",
    });
    assert.equal(viaLink.status, 403);
    assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "keep");
    const removed = await call(ctx, "/api/v1/delete", {
      token,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: link }),
    });
    assert.equal(removed.status, 200);
    assert.equal(fs.existsSync(link), false);
    assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "keep");
  } finally {
    cleanup(ctx);
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("one approval performs that write, and a lock does not ask", async () => {
  const ctx = temp();
  try {
    const { token } = createToken(ctx.file, { name: "Wait", roots: [] }, ctx.now);
    const folder = path.join(ctx.root, "later");
    const waiting = await call(ctx, "/api/v1/mkdir", {
      token,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: folder }),
    });
    const body = await waiting.json();
    assert.equal(waiting.status, 403);
    assert.equal(fs.existsSync(folder), false);
    const again = await call(ctx, "/api/v1/mkdir", {
      token,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: folder }),
    });
    assert.equal((await again.json()).approval_request_id, body.approval_request_id);

    const locked = await call(ctx, "/api/v1/mkdir", {
      token,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: path.join(ctx.root, "locked") }),
      assertWrite: () => {
        throw new Error("This action is turned off in Settings on the PC that runs Drivebay.");
      },
    });
    const lockedBody = await locked.json();
    assert.equal(locked.status, 403);
    assert.match(lockedBody.error, /turned off/);
    assert.equal(Object.hasOwn(lockedBody, "approval_request_id"), false);

    decideApproval(ctx.file, body.approval_request_id, true, 0, ctx.now);
    const done = await call(ctx, "/api/v1/mkdir", {
      token,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-drivebay-approval": body.approval_request_id,
      },
      body: JSON.stringify({ path: folder }),
    });
    assert.equal(done.status, 200);
    assert.equal(fs.existsSync(folder), true);
    const used = await call(ctx, `/api/v1/approvals/${body.approval_request_id}`, { token });
    assert.equal((await used.json()).status, "used");

    const pc = panelFor(ctx.file, { loopback: true }, ctx.now);
    assert.equal(pc.approvals.length, 0);
  } finally {
    cleanup(ctx);
  }
});

test("a pending approval expires after about 10 minutes", async () => {
  const ctx = temp();
  try {
    const { token } = createToken(ctx.file, { name: "Wait", roots: [] }, ctx.now);
    const folder = path.join(ctx.root, "later");
    const waiting = await call(ctx, "/api/v1/mkdir", {
      token,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: folder }),
    });
    const body = await waiting.json();
    decideApproval(ctx.file, body.approval_request_id, true, 0, ctx.now);
    ctx.now += APPROVAL_TTL_MS;
    const late = await call(ctx, "/api/v1/mkdir", {
      token,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-drivebay-approval": body.approval_request_id,
      },
      body: JSON.stringify({ path: folder }),
    });
    assert.equal(late.status, 403);
    assert.equal(fs.existsSync(folder), false);
    const polled = await call(ctx, `/api/v1/approvals/${body.approval_request_id}`, { token });
    assert.equal((await polled.json()).status, "expired");
    assert.throws(() => decideApproval(ctx.file, body.approval_request_id, true, 0, ctx.now), /no longer pending/);
  } finally {
    cleanup(ctx);
  }
});
