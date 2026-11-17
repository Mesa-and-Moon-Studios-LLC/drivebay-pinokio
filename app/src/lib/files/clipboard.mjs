/** Cut / copy / paste helpers shared by the browser and the server. No Node APIs. */

/** "2 items cut", "1 item copied". */
export function clipboardLabel(clip) {
  const count = Array.isArray(clip?.items) ? clip.items.length : 0;
  if (!count) return "";
  const noun = count === 1 ? "item" : "items";
  return `${count} ${noun} ${clip.mode === "copy" ? "copied" : "cut"}`;
}

function norm(p, sep) {
  let text = String(p || "");
  if (sep === "\\") text = text.replace(/\//g, "\\").toLowerCase();
  while (text.length > 1 && text.endsWith(sep) && !/^[a-z]:\\$/i.test(text)) text = text.slice(0, -1);
  return text;
}

/** True when `child` is `parent` or sits somewhere under it. */
export function isSameOrInside(child, parent, sep = "/") {
  const c = norm(child, sep);
  const p = norm(parent, sep);
  if (!c || !p) return false;
  if (c === p) return true;
  return c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** "photo.jpg" -> "photo (copy).jpg", then "photo (copy 2).jpg" ... until it is free. */
export function uniquePasteName(name, taken) {
  const used = taken instanceof Set ? taken : new Set(taken || []);
  if (!used.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const hasExt = dot > 0;
  const base = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : "";
  for (let i = 1; i < 10000; i += 1) {
    const next = `${base} (copy${i === 1 ? "" : ` ${i}`})${ext}`;
    if (!used.has(next)) return next;
  }
  throw new Error("Too many copies with that name");
}

/** Why a paste cannot run, or "" when it can. */
export function pasteProblem(clip, dest, sep = "/") {
  if (!clip || !Array.isArray(clip.items) || clip.items.length === 0) return "Nothing to paste";
  if (!dest) return "Open a folder to paste into";
  for (const item of clip.items) {
    if (item.kind === "dir" && isSameOrInside(dest, item.path, sep)) {
      return `Cannot paste “${item.name}” into itself`;
    }
  }
  if (clip.mode === "cut" && clip.items.every((item) => norm(parentOf(item.path, sep), sep) === norm(dest, sep))) {
    return "Those items are already in this folder";
  }
  return "";
}

export function parentOf(p, sep = "/") {
  const text = String(p || "");
  const cut = sep === "\\" ? Math.max(text.lastIndexOf("\\"), text.lastIndexOf("/")) : text.lastIndexOf("/");
  if (cut <= 0) return sep === "\\" ? text.slice(0, 3) : "/";
  if (sep === "\\" && cut === 2) return text.slice(0, 3);
  return text.slice(0, cut);
}
