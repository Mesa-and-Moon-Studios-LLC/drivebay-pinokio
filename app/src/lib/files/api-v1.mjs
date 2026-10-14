/**
 * Bearer API for a Drivebay token.
 * This version is read-only: roots, list, stat, search, download, and thumbnails.
 */
import { lstat, open, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PathError, insideAny, narrowRoots, readInside } from "./token-paths.mjs";
import { appendAudit, authenticateToken, hashToken, takeRate } from "./token-store.mjs";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"]);
const THUMB_MAX = 2 * 1024 * 1024;
const MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  txt: "text/plain",
  json: "application/json",
  pdf: "application/pdf",
};
const SKIP_DIR = new Set(["node_modules", ".git", ".svn", "$recycle.bin", "system volume information"]);

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function bearer(request) {
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  return match ? match[1] : "";
}

function extOf(name) {
  const base = path.basename(name);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function kindOf(st) {
  if (st.isSymbolicLink()) return "link";
  if (st.isDirectory()) return "dir";
  if (st.isFile()) return "file";
  return "other";
}

function entryOf(dir, name, st) {
  return {
    name,
    path: path.join(dir, name),
    kind: kindOf(st),
    size: st.isFile() && !st.isSymbolicLink() ? st.size : null,
    mtime: st.mtimeMs,
  };
}

function hasScope(token, name) {
  return Array.isArray(token.scope) && token.scope.includes(name);
}

async function allowedRoots(token, deps) {
  const drives = await deps.roots();
  const paths = (Array.isArray(drives) ? drives : []).map((drive) => (typeof drive === "string" ? drive : drive.path));
  return narrowRoots(paths, token.roots);
}

function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return { error: true };
  const startRaw = match[1];
  const endRaw = match[2];
  if (startRaw === "" && endRaw === "") return { error: true };
  let start;
  let end;
  if (startRaw === "") {
    const suffix = Number(endRaw);
    if (!Number.isInteger(suffix) || suffix <= 0) return { error: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startRaw);
    end = endRaw === "" ? size - 1 : Number(endRaw);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) {
    return { error: true };
  }
  return { start, end: Math.min(end, size - 1) };
}

async function readSpan(file, start, length) {
  const handle = await open(file, "r");
  try {
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, start);
    return buf;
  } finally {
    await handle.close();
  }
}

function safeError(err) {
  if (err instanceof PathError) return err.message;
  const known = new Set([
    "Not a folder",
    "Not a file",
    "Type at least 2 characters",
    "This token cannot do that.",
  ]);
  if (err && known.has(err.message)) return err.message;
  return "Request failed";
}

function statusFor(err) {
  if (err instanceof PathError) {
    if (err.code === "not_found") return 404;
    if (err.code === "invalid") return 400;
    return 403;
  }
  return 400;
}

async function listDir(dir, roots) {
  const names = await readdir(dir);
  const entries = [];
  for (const name of names) {
    let st;
    try {
      st = await lstat(path.join(dir, name));
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      entries.push(entryOf(dir, name, st));
      continue;
    }
    const full = path.join(dir, name);
    if (!insideAny(full, roots)) continue;
    entries.push(entryOf(dir, name, st));
  }
  entries.sort((a, b) => {
    if (a.kind === "dir" && b.kind !== "dir") return -1;
    if (a.kind !== "dir" && b.kind === "dir") return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  return entries;
}

async function searchTree(root, query, roots) {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) throw new Error("Type at least 2 characters");
  const hits = [];
  let truncated = false;
  let visits = 0;
  const deadline = Date.now() + 4000;

  async function walk(dir) {
    if (truncated) return;
    if (Date.now() > deadline || visits >= 4000 || hits.length >= 200) {
      truncated = true;
      return;
    }
    visits += 1;
    let names;
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (truncated) return;
      const full = path.join(dir, name);
      let st;
      try {
        st = await lstat(full);
      } catch {
        continue;
      }
      if (name.toLowerCase().includes(needle) && (st.isSymbolicLink() || insideAny(full, roots))) {
        hits.push(entryOf(dir, name, st));
        if (hits.length >= 200) {
          truncated = true;
          return;
        }
      }
      if (st.isDirectory() && !st.isSymbolicLink() && !SKIP_DIR.has(name.toLowerCase()) && insideAny(full, roots)) {
        await walk(full);
      }
    }
  }

  await walk(root);
  return { hits, truncated };
}

/**
 * @param {Request} request
 * @param {{ file: string, roots: () => Promise<unknown>, now?: () => number, ratePerMinute?: number }} deps
 */
export async function handleTokenApi(request, deps) {
  const now = typeof deps.now === "function" ? deps.now() : Date.now();
  const url = new URL(request.url);
  const match = url.pathname.match(/\/api\/v1(?:\/([^?#]*))?$/);
  if (!match) return json(404, { error: "Not found" });
  let rest = "";
  try {
    rest = decodeURIComponent(match[1] || "");
  } catch {
    return json(400, { error: "Invalid path" });
  }
  const parts = rest.split("/").filter(Boolean);
  const action = parts[0] || "";
  const presented = bearer(request);
  if (!presented) return json(401, { error: "Missing bearer token" });
  const limit = deps.ratePerMinute || 60;
  const rate = takeRate(`${deps.file}:${hashToken(presented)}`, now, limit);
  if (!rate.ok) {
    return json(429, { error: "Too many requests" }, { "retry-after": String(rate.retryAfter) });
  }
  const token = authenticateToken(deps.file, presented, now);
  if (!token) return json(401, { error: "Invalid token" });

  let response;
  let detail = "";
  let auditPath = url.searchParams.get("path") || "";
  try {
    const outcome = await dispatch({ request, url, deps, token, now, action, parts });
    response = outcome.response;
    detail = outcome.detail || "";
    if (outcome.path) auditPath = outcome.path;
  } catch (err) {
    const message = safeError(err);
    response = json(statusFor(err), { error: message });
    detail = message;
  }
  try {
    appendAudit(deps.file, {
      at: now,
      tokenId: token.id,
      tokenName: token.name,
      action,
      path: auditPath,
      status: response.status,
      detail,
    });
  } catch {
    /* The action already finished. A full audit file should not hide the response. */
  }
  return response;
}

async function dispatch(ctx) {
  const reads = {
    roots: ["GET", readRoots],
    list: ["GET", readList],
    stat: ["GET", readStat],
    search: ["GET", readSearch],
    download: ["GET", readDownload],
    thumb: ["GET", readThumb],
  };
  if (reads[ctx.action]) {
    const [method, fn] = reads[ctx.action];
    if (ctx.request.method !== method) return { response: json(405, { error: "Method not allowed" }) };
    if (!hasScope(ctx.token, ctx.action)) {
      return { response: json(403, { error: "This token cannot do that." }), detail: "scope" };
    }
    return fn(ctx);
  }
  return { response: json(404, { error: "Not found" }) };
}

async function readRoots(ctx) {
  const drives = await ctx.deps.roots();
  const roots = await allowedRoots(ctx.token, ctx.deps);
  if (ctx.token.roots && ctx.token.roots.length) {
    const listed = roots.map((real) => ({
      id: path.basename(real) || real,
      path: real,
      label: path.basename(real) || real,
    }));
    return { response: json(200, { roots: listed }), detail: String(listed.length) };
  }
  const listed = [];
  for (const drive of Array.isArray(drives) ? drives : []) {
    const drivePath = typeof drive === "string" ? drive : drive.path;
    let real = "";
    try {
      real = (await narrowRoots([drivePath], []))[0] || "";
    } catch {
      real = "";
    }
    if (!real || !insideAny(real, roots)) continue;
    listed.push({
      id: typeof drive === "string" ? path.basename(real) : drive.id,
      path: real,
      label: typeof drive === "string" ? path.basename(real) : drive.label,
    });
  }
  return { response: json(200, { roots: listed }), detail: String(listed.length) };
}

async function pathQuery(ctx) {
  const raw = ctx.url.searchParams.get("path") || "";
  if (!raw) throw new PathError("invalid", "Invalid path");
  const roots = await allowedRoots(ctx.token, ctx.deps);
  return { raw, roots };
}

async function readList(ctx) {
  const { raw, roots } = await pathQuery(ctx);
  const found = await readInside(raw, roots);
  if (!found.stat.isDirectory()) throw new Error("Not a folder");
  const entries = await listDir(found.path, roots);
  return { response: json(200, { path: found.path, entries }), path: found.path };
}

async function readStat(ctx) {
  const { raw, roots } = await pathQuery(ctx);
  const found = await readInside(raw, roots);
  const st = found.stat;
  return {
    response: json(200, {
      path: found.path,
      kind: st.isDirectory() ? "dir" : st.isFile() ? "file" : "other",
      size: st.isFile() ? st.size : null,
      mtime: st.mtimeMs,
    }),
    path: found.path,
  };
}

async function readSearch(ctx) {
  const { raw, roots } = await pathQuery(ctx);
  const found = await readInside(raw, roots);
  if (!found.stat.isDirectory()) throw new Error("Not a folder");
  const query = ctx.url.searchParams.get("q") || "";
  const result = await searchTree(found.path, query, roots);
  return {
    response: json(200, { path: found.path, query: query.trim().toLowerCase(), hits: result.hits, truncated: result.truncated }),
    path: found.path,
  };
}

async function readDownload(ctx) {
  const { raw, roots } = await pathQuery(ctx);
  const found = await readInside(raw, roots);
  if (!found.stat.isFile()) throw new Error("Not a file");
  const size = found.stat.size;
  const range = parseRange(ctx.request.headers.get("range"), size);
  if (range && range.error) {
    return {
      response: new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${size}`, "cache-control": "no-store" },
      }),
      path: found.path,
      detail: "range",
    };
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : Math.max(0, size - 1);
  const length = size === 0 ? 0 : end - start + 1;
  const body = length === 0 ? Buffer.alloc(0) : await readSpan(found.path, start, length);
  const type = MIME[extOf(found.path)] || "application/octet-stream";
  const filename = path.basename(found.path).replace(/["\r\n]/g, "");
  const headers = {
    "content-type": type,
    "content-length": String(body.length),
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    "content-disposition": `attachment; filename="${filename}"`,
    "x-content-type-options": "nosniff",
  };
  if (range) headers["content-range"] = `bytes ${start}-${end}/${size}`;
  return { response: new Response(body, { status: range ? 206 : 200, headers }), path: found.path };
}

async function readThumb(ctx) {
  const { raw, roots } = await pathQuery(ctx);
  const found = await readInside(raw, roots);
  if (!found.stat.isFile()) throw new Error("Not a file");
  const ext = extOf(found.path);
  if (!IMAGE_EXT.has(ext)) return { response: json(415, { error: "Not an image" }), path: found.path };
  if (found.stat.size > THUMB_MAX) return { response: json(413, { error: "Thumbnail is too large" }), path: found.path };
  const body = await readFile(found.path);
  return {
    response: new Response(body, {
      status: 200,
      headers: {
        "content-type": MIME[ext] || "application/octet-stream",
        "content-length": String(body.length),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    }),
    path: found.path,
  };
}
