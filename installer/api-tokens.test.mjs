import assert from "node:assert/strict";
import fs from "node:fs";
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
  listPendingApprovals,
  panelFor,
  readApiAccess,
  resetRateLimits,
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
    assert.equal(rootBody.roots[0].path, ctx.root);

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

    allowWrite(ctx.file, readApiAccess(ctx.file).tokens[0].id, 15, ctx.now);
    const removed = await call(ctx, "/api/v1/delete", {
      token,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: link }),
    });
    assert.equal(removed.status, 200);
    assert.equal(fs.existsSync(link), false);
    assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), sentinel);
  } finally {
    cleanup(ctx);
    fs.rmSync(outside, { recursive: true, force: true });
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
    assert.equal(await allowed.text(), "visible");
    const roots = await call(ctx, "/api/v1/roots", { token });
    const body = await roots.json();
    assert.equal(body.roots.length, 1);
    assert.equal(body.roots[0].path, only);
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
    const id = live.record.id;
    const { revokeToken } = await import("../app/src/lib/files/token-store.mjs");
    revokeToken(ctx.file, id, ctx.now);
    const gone = await call(ctx, "/api/v1/roots", { token: live.token });
    assert.equal(gone.status, 401);
    const wrong = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
    const mismatch = await call(ctx, "/api/v1/roots", { token: wrong });
    assert.equal(mismatch.status, 401);
  } finally {
    cleanup(ctx);
  }
});

test("writes need a window or one approval and still obey the server lock", async () => {
  const ctx = temp();
  try {
    const { token, record } = createToken(ctx.file, { name: "Writer", roots: [] }, ctx.now);
    const folder = path.join(ctx.root, "made");
    const blocked = await call(ctx, "/api/v1/mkdir", {
      token,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: folder }),
    });
    assert.equal(blocked.status, 403);
    const blockedBody = await blocked.json();
    assert.ok(blockedBody.approval_request_id);
    assert.equal(fs.existsSync(folder), false);

    const again = await call(ctx, "/api/v1/mkdir", {
      token,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: folder }),
    });
    const againBody = await again.json();
    assert.equal(againBody.approval_request_id, blockedBody.approval_request_id);

    const pending = await call(ctx, `/api/v1/approvals/${blockedBody.approval_request_id}`, { token });
    assert.equal((await pending.json()).status, "pending");

    decideApproval(ctx.file, blockedBody.approval_request_id, true, 0, ctx.now);
    const made = await call(ctx, "/api/v1/mkdir", {
      token,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-drivebay-approval": blockedBody.approval_request_id,
      },
      body: JSON.stringify({ path: folder }),
    });
    assert.equal(made.status, 200);
    assert.equal(fs.statSync(folder).isDirectory(), true);
    const used = await call(ctx, `/api/v1/approvals/${blockedBody.approval_request_id}`, { token });
    assert.equal((await used.json()).status, "used");

    const filePath = path.join(ctx.root, "up.txt");
    const conflict = await call(ctx, `/api/v1/upload?path=${encodeURIComponent(filePath)}`, {
      token,
      method: "PUT",
      body: "one",
    });
    assert.equal(conflict.status, 403);
    fs.writeFileSync(filePath, "keep");
    const noClobber = await call(ctx, `/api/v1/upload?path=${encodeURIComponent(filePath)}&overwrite=1`, {
      token,
      method: "PUT",
      body: "two",
    });
    assert.equal(noClobber.status, 403);
    assert.equal(fs.readFileSync(filePath, "utf8"), "keep");

    allowWrite(ctx.file, record.id, 15, ctx.now);
    const replaced = await call(ctx, `/api/v1/upload?path=${encodeURIComponent(filePath)}&overwrite=1`, {
      token,
      method: "PUT",
      body: "two",
    });
    assert.equal(replaced.status, 200);
    assert.equal(fs.readFileSync(filePath, "utf8"), "two");
    const fresh = await call(ctx, `/api/v1/upload?path=${encodeURIComponent(path.join(ctx.root, "new.txt"))}`, {
      token,
      method: "PUT",
      body: "new",
    });
    assert.equal(fresh.status, 200);
    const clash = await call(ctx, `/api/v1/upload?path=${encodeURIComponent(path.join(ctx.root, "new.txt"))}`, {
      token,
      method: "PUT",
      body: "other",
    });
    assert.equal(clash.status, 409);
    assert.equal(fs.readFileSync(path.join(ctx.root, "new.txt"), "utf8"), "new");

    const renamed = await call(ctx, "/api/v1/rename", {
      token,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: path.join(ctx.root, "new.txt"), name: "moved.txt" }),
    });
    assert.equal(renamed.status, 200);
    assert.equal(fs.existsSync(path.join(ctx.root, "moved.txt")), true);

    ctx.now += 15 * 60 * 1000;
    const closed = await call(ctx, "/api/v1/delete", {
      token,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: path.join(ctx.root, "moved.txt") }),
    });
    assert.equal(closed.status, 403);
    assert.equal(fs.existsSync(path.join(ctx.root, "moved.txt")), true);
    const closedBody = await closed.json();
    decideApproval(ctx.file, closedBody.approval_request_id, true, 15, ctx.now);
    const afterWindow = await call(ctx, "/api/v1/delete", {
      token,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: path.join(ctx.root, "moved.txt") }),
    });
    assert.equal(afterWindow.status, 200);
    assert.equal(fs.existsSync(path.join(ctx.root, "moved.txt")), false);

    ctx.now += 15 * 60 * 1000;
    const locked = await call(ctx, "/api/v1/delete", {
      token,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: folder }),
      assertWrite(action) {
        if (action === "delete") throw new Error("This action is turned off in Settings on the PC that runs Drivebay.");
      },
    });
    assert.equal(locked.status, 403);
    const lockedBody = await locked.json();
    assert.equal(lockedBody.approval_request_id, undefined);
    assert.match(lockedBody.error, /turned off/);
    assert.equal(fs.existsSync(folder), true);
    assert.equal(listPendingApprovals(ctx.file, ctx.now).some((item) => item.action === "delete" && item.path === folder), false);
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

test("the settings panel is loopback for management and tailnet for the write window", () => {
  const ctx = temp();
  try {
    createToken(ctx.file, { name: "Desk", roots: [ctx.root] }, ctx.now);
    const quiet = panelFor(ctx.file, { loopback: false, tailnet: false }, ctx.now);
    assert.equal(quiet.canManage, false);
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
    assert.deepEqual(pc.tokens[0].roots, [ctx.root]);
  } finally {
    cleanup(ctx);
  }
});

test("token management stays on this PC and a Tailscale device can open a write window", () => {
  const api = fs.readFileSync(path.join(repo, "app/src/lib/files/api.functions.ts"), "utf8");
  const create = api.slice(api.indexOf("export const createApiToken"), api.indexOf("export const revokeApiToken"));
  assert.match(create, /assertLoopbackRequest/);
  assert.equal(create.includes("assertPublicAccessEditor"), false);
  const revoke = api.slice(api.indexOf("export const revokeApiToken"), api.indexOf("export const allowApiWrite"));
  assert.match(revoke, /assertLoopbackRequest/);
  const allow = api.slice(api.indexOf("export const allowApiWrite"), api.indexOf("export const decideApiApproval"));
  assert.match(allow, /assertPublicAccessEditor/);
  assert.equal(allow.includes("assertLoopbackRequest"), false);
  const decide = api.slice(api.indexOf("export const decideApiApproval"));
  assert.match(decide, /assertLoopbackRequest/);
  assert.equal(decide.includes("assertPublicAccessEditor"), false);

  const settings = fs.readFileSync(path.join(repo, "app/src/routes/settings.tsx"), "utf8");
  assert.match(settings, /<ApiTokens \/>/);
  const ui = fs.readFileSync(path.join(repo, "app/src/components/settings/api-tokens.tsx"), "utf8");
  assert.match(ui, /Allow write for/);
  assert.match(ui, /waiting/);
  assert.match(ui, /Copy this token now/);
  assert.match(ui, /Audit log/);
  assert.match(ui, /setInterval/);
});

test("the v1 route is registered and API paths stay JSON", () => {
  const route = fs.readFileSync(path.join(repo, "app/src/routes/api/v1/$.ts"), "utf8");
  const tree = fs.readFileSync(path.join(repo, "app/src/routeTree.gen.ts"), "utf8");
  const server = fs.readFileSync(path.join(repo, "app/src/lib/files/api-v1.server.ts"), "utf8");
  assert.match(route, /createFileRoute\("\/api\/v1\/\$"\)/);
  assert.match(route, /handleApiV1/);
  assert.match(tree, /\/api\/v1\/\$/);
  assert.match(server, /assertPolicy/);
  assert.match(server, /assertUploadSize/);
  assert.match(server, /listEnabledDrives/);
  assert.equal(wantsJsonError("/api/v1/download", ""), true);
  assert.equal(wantsJsonError("/api/v1/approvals/abc", null), true);
});
