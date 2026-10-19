/**
 * Read picked files before the input is cleared.
 * Android WebView drops the underlying content URI when the input value is
 * reset, so the bytes have to be copied first. A phone browser keeps the File.
 *
 * @param {ArrayLike<{ name?: string, type?: string, lastModified?: number }> | null | undefined} files
 * @param {(file: { name?: string, type?: string, lastModified?: number }) => Promise<ArrayBuffer | Uint8Array>} readFile
 */
export async function snapshotUploadFiles(files, readFile) {
  const list = Array.from(files || []);
  const out = [];
  for (const file of list) {
    const bytes = await readFile(file);
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    out.push({
      name: file.name || "upload",
      type: file.type || "application/octet-stream",
      lastModified: file.lastModified || Date.now(),
      bytes: data,
    });
  }
  return out;
}
