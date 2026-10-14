/**
 * Keep a token inside its allowed roots.
 * realpath follows symlinks and expands short Windows names.
 * The result has to stay under a root.
 */
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

export class PathError extends Error {
  /**
   * @param {"outside" | "not_found" | "invalid"} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "PathError";
  }
}

const OUTSIDE = "Path is outside the allowed roots.";
const NOT_FOUND = "Path not found";
const INVALID = "Invalid path";

function clean(input) {
  if (typeof input !== "string" || !input.trim() || input.length > 4096 || input.includes("\0")) {
    throw new PathError("invalid", INVALID);
  }
  return path.resolve(input.trim());
}

function normalize(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function pathInside(target, root) {
  const left = normalize(target);
  const right = normalize(root);
  if (left === right) return true;
  const prefix = right.endsWith(path.sep) ? right : right + path.sep;
  return left.startsWith(prefix);
}

export function insideAny(target, roots) {
  return roots.some((root) => pathInside(target, root));
}

export async function realRoots(candidates) {
  const out = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    try {
      const real = await realpath(candidate);
      const key = normalize(real);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(real);
    } catch {
      /* A missing drive is not an allowed root. */
    }
  }
  return out;
}

export async function narrowRoots(drivePaths, tokenRoots) {
  const drives = await realRoots(drivePaths);
  if (!tokenRoots || !tokenRoots.length) return drives;
  const narrowed = [];
  const seen = new Set();
  for (const candidate of tokenRoots) {
    try {
      const real = await realpath(candidate);
      if (!insideAny(real, drives)) continue;
      const key = normalize(real);
      if (seen.has(key)) continue;
      seen.add(key);
      narrowed.push(real);
    } catch {
      /* Skip a root that is not there yet. */
    }
  }
  return narrowed;
}

/** Walk up to a path that exists, realpath it, and put the missing tail back. */
async function existingReal(resolved) {
  let current = resolved;
  const missing = [];
  while (true) {
    try {
      let dest = await realpath(current);
      for (let i = missing.length - 1; i >= 0; i -= 1) dest = path.join(dest, missing[i]);
      return dest;
    } catch (err) {
      if (!err || err.code !== "ENOENT") throw new PathError("invalid", INVALID);
      const parent = path.dirname(current);
      if (parent === current) throw new PathError("not_found", NOT_FOUND);
      const base = path.basename(current);
      if (!base || base === "." || base === "..") throw new PathError("invalid", INVALID);
      missing.push(base);
      current = parent;
    }
  }
}

/**
 * The named entry under its real parent.
 * A final symlink is not followed here, so a link can be judged on its own.
 * Short Windows names in the parent are expanded.
 */
async function anchor(resolved) {
  const parent = path.dirname(resolved);
  const base = path.basename(resolved);
  if (!base || base === "." || base === "..") throw new PathError("invalid", INVALID);
  try {
    const parentReal = await realpath(parent);
    const st = await stat(parentReal);
    if (!st.isDirectory()) throw new PathError("invalid", "Not a folder");
    return path.join(parentReal, base);
  } catch (err) {
    if (err instanceof PathError) throw err;
    if (!err || err.code !== "ENOENT") throw new PathError("invalid", INVALID);
  }
  return path.join(await existingReal(parent), base);
}

/** Follow the final path. A symlink that lands outside the roots is refused. */
export async function readInside(input, roots) {
  const dest = await anchor(clean(input));
  let real;
  try {
    real = await realpath(dest);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      if (!insideAny(dest, roots)) throw new PathError("outside", OUTSIDE);
      throw new PathError("not_found", NOT_FOUND);
    }
    throw new PathError("invalid", INVALID);
  }
  if (!insideAny(real, roots)) throw new PathError("outside", OUTSIDE);
  const st = await stat(real);
  return { path: real, stat: st, link: false };
}

/**
 * A new file or folder. The parent is realpath'd and must sit inside a root.
 * An existing symlink is not followed into a write.
 */
export async function createInside(input, roots) {
  const resolved = clean(input);
  const dest = await anchor(resolved);
  if (!insideAny(dest, roots)) throw new PathError("outside", OUTSIDE);
  let existing = null;
  try {
    existing = await lstat(dest);
  } catch (err) {
    if (!err || err.code !== "ENOENT") throw new PathError("invalid", INVALID);
  }
  if (existing) {
    if (existing.isSymbolicLink()) throw new PathError("outside", OUTSIDE);
    return readInside(dest, roots);
  }
  return { path: dest, stat: null, link: false };
}

/** Rename and delete act on the named entry. A symlink is removed, not its target. */
export async function mutateInside(input, roots) {
  const dest = await anchor(clean(input));
  if (!insideAny(dest, roots)) throw new PathError("outside", OUTSIDE);
  let st;
  try {
    st = await lstat(dest);
  } catch (err) {
    if (err && err.code === "ENOENT") throw new PathError("not_found", NOT_FOUND);
    throw new PathError("invalid", INVALID);
  }
  if (st.isSymbolicLink()) return { path: dest, stat: st, link: true };
  const real = await realpath(dest);
  if (!insideAny(real, roots)) throw new PathError("outside", OUTSIDE);
  return { path: real, stat: await stat(real), link: false };
}
