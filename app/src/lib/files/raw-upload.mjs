/** Checks for POST /api/upload before the file is written. */
export function planRawUpload({ parent, name, length, maxBytes, allowUpload }) {
  if (allowUpload === false) {
    return { ok: false, status: 403, error: "Upload is turned off in Settings on the PC that runs Drivebay." };
  }
  if (!parent || typeof parent !== "string") return { ok: false, status: 400, error: "Missing parent" };
  if (!name || typeof name !== "string") return { ok: false, status: 400, error: "Missing name" };
  const trimmed = name.trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || /[\\/]/.test(trimmed) || trimmed.includes("\0") || trimmed.length > 255) {
    return { ok: false, status: 400, error: "Invalid name" };
  }
  if (!Number.isFinite(length) || length < 0) return { ok: false, status: 400, error: "Missing file" };
  if (length === 0) return { ok: false, status: 400, error: "The file was empty" };
  if (Number.isFinite(maxBytes) && length > maxBytes) {
    return { ok: false, status: 413, error: "File is larger than the upload limit" };
  }
  return { ok: true, status: 200, name: trimmed };
}
