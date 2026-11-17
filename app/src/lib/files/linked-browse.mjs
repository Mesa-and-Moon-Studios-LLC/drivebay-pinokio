/**
 * Browse a linked machine over WebDAV using a stored pair token.
 * Used by the desktop Settings "Open drives" UI so a trusted phone can be
 * opened in the browser without mounting a network drive.
 */

import { connectionUrl } from "./linked-machines.mjs";

function basicAuth(token) {
  return `Basic ${Buffer.from(`drivebay:${token}`).toString("base64")}`;
}

function originOf(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "";
  }
}

export function browseOrigin(machine) {
  const target = connectionUrl(machine);
  if (target.url) return originOf(target.url);
  const port = Number(machine?.port) || 0;
  const host = String(machine?.tailscaleHost || machine?.lanAddress || ((machine?.directInternet && machine?.publicHost) || "") || "");
  if (!host || port < 1) return "";
  const literal = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${literal}:${port}`;
}

export function browseUrl(machine, path = "/") {
  const origin = browseOrigin(machine);
  if (!origin) return "";
  const clean = normalizePath(path);
  const encoded = clean.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  const prefix = machine?.type === "phone" ? "" : "/dav";
  return `${origin}${prefix}/${encoded}`;
}

export function normalizePath(path) {
  const parts = [];
  for (const part of String(path || "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return "/" + parts.join("/");
}

function hrefPath(href, origin, prefix) {
  try {
    const url = new URL(String(href || ""), origin + "/");
    let path = decodeURIComponent(url.pathname || "/");
    if (prefix && path.startsWith(prefix)) path = path.slice(prefix.length) || "/";
    if (!path.startsWith("/")) path = `/${path}`;
    return path;
  } catch {
    return "";
  }
}

function parsePropfind(xml, origin, prefix, requested) {
  const entries = [];
  const blocks = String(xml || "").split(/<[\w.-]*:?response[>\s]/i).slice(1);
  for (const block of blocks) {
    const href = (block.match(/<[\w.-]*:?href[^>]*>([^<]*)<\//i) || [])[1] || "";
    const path = hrefPath(href, origin, prefix);
    if (!path) continue;
    const collection = /<[\w.-]*:?resourcetype[^>]*>[\s\S]*?collection/i.test(block);
    const name = path === "/" ? (requested === "/" ? "Storage" : requested.split("/").filter(Boolean).pop() || "Storage") : path.split("/").filter(Boolean).pop() || path;
    const size = Number((block.match(/<[\w.-]*:?getcontentlength[^>]*>(\d+)<\//i) || [])[1] || 0);
    const modified = (block.match(/<[\w.-]*:?getlastmodified[^>]*>([^<]*)<\//i) || [])[1] || "";
    entries.push({ path, name, directory: collection, size, modified });
  }
  return entries;
}

export async function listRemote({ machine, token, path = "/", fetchImpl = fetch }) {
  const url = browseUrl(machine, path);
  if (!url) return { ok: false, error: "That machine has no Tailscale or LAN address.", entries: [] };
  const origin = originOf(url);
  const prefix = machine?.type === "phone" ? "" : "/dav";
  let res;
  try {
    res = await fetchImpl(url, {
      method: "PROPFIND",
      headers: {
        authorization: basicAuth(token),
        depth: "1",
        "content-type": "application/xml; charset=utf-8",
      },
      body: `<?xml version="1.0"?><propfind xmlns="DAV:"><prop><resourcetype/><getcontentlength/><getlastmodified/><displayname/></prop></propfind>`,
    });
  } catch {
    return { ok: false, error: "Could not reach that machine.", entries: [] };
  }
  if (res.status === 401) return { ok: false, error: "This computer is not approved to browse that machine yet.", entries: [] };
  if (!res.ok && res.status !== 207) return { ok: false, error: `That machine answered ${res.status}.`, entries: [] };
  const xml = await res.text();
  const requested = normalizePath(path);
  const entries = parsePropfind(xml, origin, prefix, requested)
    .filter((row) => row.path !== requested)
    .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  return { ok: true, entries, path: requested };
}

export async function mutateRemote({ machine, token, method, path, destination, body, fetchImpl = fetch }) {
  const url = browseUrl(machine, path);
  if (!url) return { ok: false, error: "That machine has no Tailscale or LAN address." };
  const headers = { authorization: basicAuth(token) };
  if (destination) {
    const dest = browseUrl(machine, destination);
    if (dest) headers.destination = dest;
  }
  let res;
  try {
    res = await fetchImpl(url, { method, headers, body });
  } catch {
    return { ok: false, error: "Could not reach that machine." };
  }
  if (res.status === 401) return { ok: false, error: "This computer is not approved to browse that machine yet." };
  if (!res.ok && res.status !== 201 && res.status !== 204) {
    return { ok: false, error: `That machine answered ${res.status}.` };
  }
  return { ok: true };
}

export async function readRemote({ machine, token, path, fetchImpl = fetch }) {
  const url = browseUrl(machine, path);
  if (!url) return { ok: false, error: "That machine has no Tailscale or LAN address." };
  let res;
  try {
    res = await fetchImpl(url, { method: "GET", headers: { authorization: basicAuth(token) } });
  } catch {
    return { ok: false, error: "Could not reach that machine." };
  }
  if (!res.ok) return { ok: false, error: `That machine answered ${res.status}.` };
  const bytes = Buffer.from(await res.arrayBuffer());
  const name = normalizePath(path).split("/").filter(Boolean).pop() || "file";
  return { ok: true, bytes, name, type: res.headers.get("content-type") || "application/octet-stream" };
}

/** Ask a peer to drop this trust relationship. Failures are ignored so a local forget still happens. */
export async function notifyPeerForget({ url, token, fromId, peerId, signature, issuedAt, fetchImpl = fetch }) {
  if (!url) return { ok: false };
  const origin = originOf(url);
  if (!origin) return { ok: false };
  try {
    const res = await fetchImpl(`${origin}/api/link/forget`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ fromId, peerId, signature, issuedAt }),
    });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}
