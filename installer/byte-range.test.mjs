import assert from "node:assert/strict";
import test from "node:test";
import { etagFor, ifRangeAllowsPartial, parseByteRange, planDownload, responseHeaders } from "../app/src/lib/files/byte-range.mjs";

const size = 10;
const mtime = Date.parse("2026-01-02T03:04:05.678Z");

test("ETag is a strong validator from size and mtime", () => {
  assert.equal(etagFor(size, mtime), `"10-${mtime}"`);
  assert.equal(etagFor(0, Number.NaN), `"0-0"`);
});

test("planDownload serves a full file, a slice, and 416", () => {
  const full = planDownload({ size, mtimeMs: mtime, method: "GET" });
  assert.equal(full.status, 200);
  assert.equal(full.kind, "full");
  assert.equal(full.length, 10);
  assert.equal(full.head, false);

  const part = planDownload({ size, mtimeMs: mtime, rangeHeader: "bytes=2-5" });
  assert.equal(part.status, 206);
  assert.equal(part.start, 2);
  assert.equal(part.end, 5);
  assert.equal(part.length, 4);
  const headers = responseHeaders(part, { contentType: "text/plain" });
  assert.equal(headers["Accept-Ranges"], "bytes");
  assert.equal(headers["Content-Range"], "bytes 2-5/10");
  assert.equal(headers["Content-Length"], "4");
  assert.equal(headers.ETag, etagFor(size, mtime));

  const open = planDownload({ size, mtimeMs: mtime, rangeHeader: "bytes=7-" });
  assert.equal(open.start, 7);
  assert.equal(open.end, 9);

  const suffix = planDownload({ size, mtimeMs: mtime, rangeHeader: "bytes=-3" });
  assert.equal(suffix.start, 7);
  assert.equal(suffix.end, 9);

  const bad = planDownload({ size, mtimeMs: mtime, rangeHeader: "bytes=20-21" });
  assert.equal(bad.status, 416);
  assert.equal(responseHeaders(bad)["Content-Range"], "bytes */10");
  assert.equal(responseHeaders(bad)["Content-Length"], undefined);

  const multi = planDownload({ size, mtimeMs: mtime, rangeHeader: "bytes=0-1,2-3" });
  assert.equal(multi.status, 416);
});

test("HEAD carries the same validators and no requirement for a body", () => {
  const head = planDownload({ size, mtimeMs: mtime, method: "HEAD" });
  assert.equal(head.head, true);
  assert.equal(head.status, 200);
  assert.equal(responseHeaders(head)["Accept-Ranges"], "bytes");
  assert.equal(responseHeaders(head)["Content-Length"], "10");

  const ranged = planDownload({ size, mtimeMs: mtime, method: "HEAD", rangeHeader: "bytes=0-0" });
  assert.equal(ranged.head, true);
  assert.equal(ranged.status, 206);
  assert.equal(ranged.length, 1);
});

test("If-Range keeps the slice only when the validator still matches", () => {
  const etag = etagFor(size, mtime);
  assert.equal(ifRangeAllowsPartial(null, etag, mtime), true);
  assert.equal(ifRangeAllowsPartial(etag, etag, mtime), true);
  assert.equal(ifRangeAllowsPartial('"9-1"', etag, mtime), false);
  assert.equal(ifRangeAllowsPartial("W/" + etag, etag, mtime), false);

  const match = planDownload({ size, mtimeMs: mtime, rangeHeader: "bytes=1-2", ifRangeHeader: etag });
  assert.equal(match.status, 206);
  assert.equal(match.start, 1);

  const stale = planDownload({ size, mtimeMs: mtime, rangeHeader: "bytes=1-2", ifRangeHeader: '"0-0"' });
  assert.equal(stale.status, 200);
  assert.equal(stale.kind, "full");
  assert.equal(stale.start, 0);
  assert.equal(stale.end, 9);

  const sameSecond = new Date(Math.floor(mtime / 1000) * 1000).toUTCString();
  const dated = planDownload({ size, mtimeMs: mtime, rangeHeader: "bytes=0-1", ifRangeHeader: sameSecond });
  assert.equal(dated.status, 206);

  const older = new Date(mtime - 5000).toUTCString();
  const changed = planDownload({ size, mtimeMs: mtime, rangeHeader: "bytes=0-1", ifRangeHeader: older });
  assert.equal(changed.status, 200);
});

test("an empty file is 200 with no range and 416 when a range is asked for", () => {
  const empty = planDownload({ size: 0, mtimeMs: 0 });
  assert.equal(empty.status, 200);
  assert.equal(empty.length, 0);
  const ranged = planDownload({ size: 0, mtimeMs: 0, rangeHeader: "bytes=0-0" });
  assert.equal(ranged.status, 416);
  assert.equal(parseByteRange("bytes=-0", 4).error, true);
});
