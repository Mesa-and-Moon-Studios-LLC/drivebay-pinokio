import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { planRawUpload } from "../app/src/lib/files/raw-upload.mjs";
import { snapshotUploadFiles } from "../app/src/lib/files/upload-files.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("raw upload rejects an empty file, a path in the name, and a locked server", () => {
  assert.equal(planRawUpload({ parent: "C:\\Drive", name: "a.txt", length: 4, allowUpload: true }).ok, true);
  assert.equal(planRawUpload({ parent: "C:\\Drive", name: "a.txt", length: 0 }).status, 400);
  assert.equal(planRawUpload({ parent: "C:\\Drive", name: "a/b.txt", length: 4 }).status, 400);
  assert.equal(planRawUpload({ parent: "", name: "a.txt", length: 4 }).status, 400);
  assert.equal(planRawUpload({ parent: "C:\\Drive", name: "a.txt", length: 4, allowUpload: false }).status, 403);
  assert.equal(planRawUpload({ parent: "C:\\Drive", name: "a.txt", length: 50, maxBytes: 10 }).status, 413);
});

test("upload bytes are copied before the file input is cleared", async () => {
  let reads = 0;
  const snaps = await snapshotUploadFiles(
    [{ name: "photo.jpg", type: "image/jpeg", lastModified: 5 }],
    async () => {
      reads += 1;
      return new Uint8Array([1, 2, 3]);
    },
  );
  assert.equal(reads, 1);
  assert.equal(snaps[0].name, "photo.jpg");
  assert.deepEqual(Array.from(snaps[0].bytes), [1, 2, 3]);

  const browser = fs.readFileSync(path.join(root, "app/src/components/browser/app.tsx"), "utf8");
  const snapAt = browser.indexOf("snapshotUploadFiles(picked");
  const clearAt = browser.indexOf('input.value = ""', snapAt);
  assert.ok(snapAt > 0 && clearAt > snapAt);
  assert.match(browser, /pickUpload/);
  const route = fs.readFileSync(path.join(root, "app/src/routes/api/upload.ts"), "utf8");
  assert.match(route, /planRawUpload/);
  assert.match(route, /assertRemoteAction\("upload"\)/);
  assert.match(route, /writeUpload/);
});
