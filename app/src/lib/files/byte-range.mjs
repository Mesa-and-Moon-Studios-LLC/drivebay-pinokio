/**
 * HTTP Range / ETag planning for GET and HEAD /api/download.
 * Pure functions so tests can cover 206, 416, and If-Range without the server.
 */

export function etagFor(size, mtimeMs) {
  const sizeN = Number(size);
  const safeSize = Number.isFinite(sizeN) && sizeN >= 0 ? Math.round(sizeN) : 0;
  const mtime = Number.isFinite(Number(mtimeMs)) ? Math.round(Number(mtimeMs)) : 0;
  return `"${safeSize}-${mtime}"`;
}

/**
 * Single range only. `bytes=start-end`, `bytes=start-`, or `bytes=-suffix`.
 * @returns {{ error: true } | { start: number, end: number }}
 */
export function parseByteRange(header, size) {
  if (header == null || String(header).trim() === "") return { error: true };
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) return { error: true };
  const startRaw = match[1];
  const endRaw = match[2];
  if (startRaw === "" && endRaw === "") return { error: true };
  const total = Number(size);
  if (!Number.isInteger(total) || total < 0) return { error: true };
  let start;
  let end;
  if (startRaw === "") {
    const suffix = Number(endRaw);
    if (!Number.isInteger(suffix) || suffix <= 0) return { error: true };
    if (total === 0) return { error: true };
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(startRaw);
    end = endRaw === "" ? total - 1 : Number(endRaw);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= total) {
    return { error: true };
  }
  return { start, end: Math.min(end, total - 1) };
}

/**
 * If-Range is absent → honor Range.
 * Strong or weak ETag must equal ours (we only emit a strong validator).
 * An HTTP-date matches when the file has not changed since that second.
 */
export function ifRangeAllowsPartial(ifRange, etag, mtimeMs) {
  if (ifRange == null) return true;
  const value = String(ifRange).trim();
  if (value === "") return true;
  if (value.startsWith('"') || value.startsWith("W/")) return value === etag;
  const when = Date.parse(value);
  if (Number.isNaN(when)) return false;
  const modifiedSec = Math.floor(Number(mtimeMs) / 1000);
  return modifiedSec <= Math.floor(when / 1000);
}

/**
 * @param {{ size: number, mtimeMs: number, rangeHeader?: string | null, ifRangeHeader?: string | null, method?: string }} input
 */
export function planDownload(input) {
  const size = Number(input.size);
  const mtimeMs = Number(input.mtimeMs);
  const etag = etagFor(size, mtimeMs);
  const method = String(input.method || "GET").toUpperCase();
  const lastModified = new Date(Number.isFinite(mtimeMs) ? mtimeMs : 0).toUTCString();
  const head = method === "HEAD";
  const full = {
    kind: "full",
    status: 200,
    size,
    start: 0,
    end: size > 0 ? size - 1 : -1,
    length: size > 0 ? size : 0,
    etag,
    lastModified,
    head,
  };
  const rangeHeader = input.rangeHeader;
  if (rangeHeader == null || String(rangeHeader).trim() === "") return full;
  if (!ifRangeAllowsPartial(input.ifRangeHeader, etag, mtimeMs)) return full;
  const parsed = parseByteRange(rangeHeader, size);
  if (parsed.error) {
    return { kind: "unsatisfiable", status: 416, size, start: -1, end: -1, length: 0, etag, lastModified, head };
  }
  const length = parsed.end - parsed.start + 1;
  return {
    kind: "partial",
    status: 206,
    size,
    start: parsed.start,
    end: parsed.end,
    length,
    etag,
    lastModified,
    head,
  };
}

export function responseHeaders(plan, extra = {}) {
  const headers = {
    "Accept-Ranges": "bytes",
    ETag: plan.etag,
    "Last-Modified": plan.lastModified,
    "Cache-Control": "no-store",
  };
  if (extra.contentType) headers["Content-Type"] = extra.contentType;
  if (extra.contentDisposition) headers["Content-Disposition"] = extra.contentDisposition;
  if (plan.kind === "unsatisfiable") {
    headers["Content-Range"] = `bytes */${plan.size}`;
    return headers;
  }
  headers["Content-Length"] = String(plan.length);
  if (plan.kind === "partial") {
    headers["Content-Range"] = `bytes ${plan.start}-${plan.end}/${plan.size}`;
  }
  return headers;
}
