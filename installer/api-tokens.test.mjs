import assert from "node:assert/strict";
import fs from "node:fs";
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { handleTokenApi } from "../app/src/lib/files/api-v1.mjs";
import { wantsJsonError } from "../app/src/lib/files/document-request.mjs";
import { createToken, panelFor, readApiAccess, resetRateLimits, revokeToken } from "../app/src/lib/files/token-store.mjs";

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
    now: () => ctx.now,
    ratePerMinute: opts.ratePerMinute || 1000,
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
    const quiet = panelFor(ctx.file, { loopback: false, tailnet: true }, ctx.now);
    assert.equal(quiet.canManage, false);
    assert.equal(quiet.tokens.length, 0);
    assert.equal(quiet.audit.length, 0);
    const pc = panelFor(ctx.file, { loopback: true, tailnet: false }, ctx.now);
    assert.equal(pc.canManage, true);
    assert.deepEqual(pc.tokens[0].roots, [ctx.root]);
    assert.equal(pc.tokens[0].name, "Desk");
  } finally {
    cleanup(ctx);
  }

  const api = fs.readFileSync(path.join(repo, "app/src/lib/files/api.functions.ts"), "utf8");
  const create = api.slice(api.indexOf("export const createApiToken"), api.indexOf("export const revokeApiToken"));
  assert.match(create, /assertLoopbackRequest/);
  assert.equal(create.includes("assertPublicAccessEditor"), false);
  const revoke = api.slice(api.indexOf("export const revokeApiToken"));
  assert.match(revoke, /assertLoopbackRequest/);
  assert.equal(revoke.includes("assertPublicAccessEditor"), false);
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
});

test("the v1 route is registered and API paths stay JSON", () => {
  const route = fs.readFileSync(path.join(repo, "app/src/routes/api/v1/$.ts"), "utf8");
  const tree = fs.readFileSync(path.join(repo, "app/src/routeTree.gen.ts"), "utf8");
  const server = fs.readFileSync(path.join(repo, "app/src/lib/files/api-v1.server.ts"), "utf8");
  assert.match(route, /createFileRoute\("\/api\/v1\/\$"\)/);
  assert.match(route, /handleApiV1/);
  assert.match(tree, /\/api\/v1\/\$/);
  assert.match(server, /listEnabledDrives/);
  assert.match(server, /allowedRoots/);
  assert.match(server, /api-access\.json/);
  assert.equal(wantsJsonError("/api/v1/download", ""), true);
  assert.equal(wantsJsonError("/api/v1/roots", null), true);
});
