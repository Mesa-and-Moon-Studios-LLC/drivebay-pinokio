/**
 * WebDAV for the folders this machine chose to share.
 * An empty list exposes nothing. Read-only folders reject writes.
 * The real disk path never appears in a listing name.
 */

import fs from "node:fs";
import path from "node:path";
import { normalizeShares, verifyPairToken } from "./linked-machines.mjs";

const WRITE_METHODS = new Set(["PUT", "DELETE", "MKCOL", "MOVE"]);

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function parseBasic(header) {
  const text = String(header || "");
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(text.trim());
  if (!match) return null;
  let decoded = "";
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return null;
  }
  const split = decoded.indexOf(":");
  if (split < 1) return null;
  return { user: decoded.slice(0, split), password: decoded.slice(split + 1) };
}

export function davAuthorized(header, pairState) {
  const parsed = parseBasic(header);
  if (!parsed || parsed.user !== "drivebay") return false;
  return verifyPairToken(pairState, parsed.password);
}

function decodePath(raw) {
  try {
    return decodeURIComponent(String(raw || "").split("?")[0]);
  } catch {
    return null;
  }
}

export function davParts(urlPath, prefix = "/dav") {
  const decoded = decodePath(urlPath);
  if (decoded == null || decoded.includes("\0")) return null;
  let rest = decoded;
  if (rest === prefix) rest = "/";
  else if (rest.startsWith(`${prefix}/`)) rest = rest.slice(prefix.length);
  else if (prefix && rest !== "/") return null;
  const parts = rest.split("/").filter((part) => part.length > 0);
  if (parts.some((part) => part === "." || part === "..")) return null;
  return parts;
}

function inside(root, candidate) {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  const rel = path.relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function realInside(root, candidate) {
  let base = root;
  let target = candidate;
  try {
    base = fs.realpathSync(root);
  } catch {
    return null;
  }
  try {
    target = fs.realpathSync(candidate);
  } catch {
    const parent = path.dirname(candidate);
    try {
      const parentReal = fs.realpathSync(parent);
      if (!inside(base, parentReal)) return null;
      target = path.resolve(parentReal, path.basename(candidate));
    } catch {
      return null;
    }
  }
  if (!inside(base, target)) return null;
  return target;
}

function findShare(shares, parts) {
  if (!parts.length) return null;
  return shares.folders.find((folder) => folder.name === parts[0]) || null;
}

function httpDate(ms) {
  return new Date(ms || Date.now()).toUTCString();
}

function propfindXml(prefix, nodes) {
  const body = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<d:multistatus xmlns:d="DAV:">',
  ];
  for (const node of nodes) {
    const href = node.href.endsWith("/") || !node.directory ? node.href : `${node.href}/`;
    body.push("<d:response><d:href>");
    body.push(xmlEscape(href));
    body.push("</d:href><d:propstat><d:prop>");
    body.push(`<d:displayname>${xmlEscape(node.name)}</d:displayname>`);
    body.push(node.directory ? "<d:resourcetype><d:collection/></d:resourcetype>" : "<d:resourcetype/>");
    body.push(`<d:getcontentlength>${node.directory ? 0 : node.size}</d:getcontentlength>`);
    body.push(`<d:getlastmodified>${xmlEscape(httpDate(node.mtimeMs))}</d:getlastmodified>`);
    body.push("</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>");
  }
  body.push("</d:multistatus>");
  return Buffer.from(body.join(""), "utf8");
}

function text(status, message, extra = {}) {
  const body = Buffer.from(message || "", "utf8");
  return {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "content-length": String(body.length),
      ...extra,
    },
    body,
  };
}

function locate(shares, parts) {
  if (!parts.length) return { kind: "root" };
  const share = findShare(shares, parts);
  if (!share) return { kind: "missing" };
  const rel = parts.slice(1);
  const candidate = path.resolve(share.path, ...rel);
  const real = realInside(share.path, rel.length ? candidate : share.path);
  if (!real) return { kind: "escape" };
  return { kind: "file", share, real, rel };
}

export function handleDav({
  method,
  urlPath,
  headers = {},
  body = Buffer.alloc(0),
  shares,
  pairState,
  prefix = "/dav",
  remoteIsPrivate = true,
  directInternet = false,
}) {
  const verb = String(method || "GET").toUpperCase();
  const allow = "OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL, MOVE, LOCK, UNLOCK";
  if (verb === "OPTIONS") {
    return {
      status: 200,
      headers: { DAV: "1, 2", Allow: allow, "content-length": "0", "cache-control": "no-store" },
      body: Buffer.alloc(0),
    };
  }
  if (!directInternet && !remoteIsPrivate) {
    return text(403, "This machine only accepts Tailscale or LAN connections.");
  }
  const headerMap = {};
  for (const [key, value] of Object.entries(headers || {})) headerMap[key.toLowerCase()] = value;
  if (!davAuthorized(headerMap.authorization, pairState)) {
    return text(401, "Sign in required", { "WWW-Authenticate": 'Basic realm="Drivebay"' });
  }
  const normalized = normalizeShares(shares);
  const parts = davParts(urlPath, prefix);
  if (!parts) return text(400, "Bad path");
  const depth = String(headerMap.depth || "1").trim().toLowerCase();
  if (verb === "PROPFIND" && depth === "infinity") return text(403, "Depth infinity is not allowed");
  const where = locate(normalized, parts);
  if (where.kind === "escape") return text(403, "That path is not shared.");
  if (where.kind === "missing") return text(404, "Missing");

  if (WRITE_METHODS.has(verb)) {
    if (where.kind === "root") return text(403, "Nothing is shared at the root.");
    if (where.share.access !== "rw") return text(403, "That folder is read-only.");
  }

  if (verb === "PROPFIND") return propfind(prefix, normalized, parts, where, depth);
  if (verb === "GET" || verb === "HEAD") return readFile(where, verb === "HEAD");
  if (verb === "PUT") return putFile(where, body);
  if (verb === "DELETE") return deletePath(where);
  if (verb === "MKCOL") return mkcol(where);
  if (verb === "MOVE") return movePath(normalized, where, headerMap.destination, prefix);
  if (verb === "LOCK") return lock(prefix, parts);
  if (verb === "UNLOCK") return { status: 204, headers: { "content-length": "0" }, body: Buffer.alloc(0) };
  return text(405, "Method not allowed", { Allow: allow });
}

function nodeInfo(real, name, href) {
  const st = fs.statSync(real);
  return {
    name,
    href,
    directory: st.isDirectory(),
    size: st.isDirectory() ? 0 : st.size,
    mtimeMs: st.mtimeMs,
  };
}

function propfind(prefix, shares, parts, where, depth) {
  if (where.kind === "root") {
    const self = { name: "Drivebay", href: `${prefix}/`, directory: true, size: 0, mtimeMs: Date.now() };
    const nodes = [self];
    if (depth !== "0") {
      for (const folder of shares.folders) {
        if (!fs.existsSync(folder.path)) continue;
        nodes.push({
          name: folder.name,
          href: `${prefix}/${encodeURIComponent(folder.name)}/`,
          directory: true,
          size: 0,
          mtimeMs: fs.statSync(folder.path).mtimeMs,
        });
      }
    }
    const body = propfindXml(prefix, nodes);
    return xml(body);
  }
  if (!fs.existsSync(where.real)) return text(404, "Missing");
  const href = `${prefix}/${parts.map(encodeURIComponent).join("/")}`;
  let self;
  try {
    self = nodeInfo(where.real, parts[parts.length - 1] || where.share.name, href);
  } catch {
    return text(404, "Missing");
  }
  const nodes = [self];
  if (depth !== "0" && self.directory) {
    let children = [];
    try {
      children = fs.readdirSync(where.real);
    } catch {
      children = [];
    }
    for (const name of children) {
      if (name === "." || name === "..") continue;
      const child = path.join(where.real, name);
      if (!realInside(where.share.path, child)) continue;
      try {
        nodes.push(nodeInfo(child, name, `${href.replace(/\/$/, "")}/${encodeURIComponent(name)}`));
      } catch {
        /* skip a child that disappeared */
      }
    }
  }
  return xml(propfindXml(prefix, nodes));
}

function xml(body) {
  return {
    status: 207,
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "content-length": String(body.length),
      "cache-control": "no-store",
    },
    body,
  };
}

function readFile(where, head) {
  if (where.kind !== "file" || !fs.existsSync(where.real)) return text(404, "Missing");
  const st = fs.statSync(where.real);
  if (st.isDirectory()) return text(405, "Folder");
  return {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(st.size),
      "accept-ranges": "bytes",
      "cache-control": "no-store",
    },
    body: head ? Buffer.alloc(0) : fs.readFileSync(where.real),
    filePath: where.real,
  };
}

function putFile(where, body) {
  if (where.kind !== "file" || !where.rel.length) return text(409, "Cannot write");
  const parent = path.dirname(where.real);
  if (!realInside(where.share.path, parent)) return text(403, "That path is not shared.");
  fs.mkdirSync(parent, { recursive: true });
  fs.writeFileSync(where.real, body);
  return text(201, "");
}

function deletePath(where) {
  if (where.kind !== "file" || !where.rel.length) return text(403, "That folder is the share itself.");
  if (!fs.existsSync(where.real)) return text(404, "Missing");
  fs.rmSync(where.real, { recursive: true, force: false });
  return { status: 204, headers: { "content-length": "0" }, body: Buffer.alloc(0) };
}

function mkcol(where) {
  if (where.kind !== "file" || !where.rel.length) return text(409, "Cannot create");
  if (fs.existsSync(where.real)) return text(409, "Cannot create");
  const parent = path.dirname(where.real);
  if (!fs.existsSync(parent)) return text(409, "Cannot create");
  fs.mkdirSync(where.real);
  return text(201, "");
}

function movePath(shares, where, destination, prefix) {
  if (!destination) return text(400, "Missing Destination");
  const raw = String(destination);
  const pathOnly = raw.includes("://") ? raw.slice(raw.indexOf("/", raw.indexOf("://") + 3)) : raw;
  const parts = davParts(pathOnly, prefix);
  if (!parts) return text(400, "Bad Destination");
  const target = locate(shares, parts);
  if (target.kind !== "file" || target.share.access !== "rw" || !target.rel.length) {
    return text(403, "That path is not shared.");
  }
  if (where.kind !== "file") return text(404, "Missing");
  fs.mkdirSync(path.dirname(target.real), { recursive: true });
  fs.renameSync(where.real, target.real);
  return text(201, "");
}

function lock(prefix, parts) {
  const token = `opaquelocktoken:${parts.join("-") || "root"}`;
  const xmlBody = Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?><d:prop xmlns:d="DAV:"><d:lockdiscovery><d:activelock><d:locktype><d:write/></d:locktype><d:lockscope><d:exclusive/></d:lockscope><d:depth>0</d:depth><d:timeout>Second-3600</d:timeout><d:locktoken><d:href>${prefix}/${token}</d:href></d:locktoken></d:activelock></d:lockdiscovery></d:prop>`,
    "utf8",
  );
  return {
    status: 200,
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "lock-token": `<${token}>`,
      "content-length": String(xmlBody.length),
    },
    body: xmlBody,
  };
}
