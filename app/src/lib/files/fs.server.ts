import { createReadStream, existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSameOrInside, uniquePasteName } from "./clipboard.mjs";
import type { DirListing, Drive, FileCategory, FsEntry, FsKind } from "./types";

const TEXT_EXTS = new Set([
  "txt",
  "md",
  "markdown",
  "json",
  "jsonc",
  "csv",
  "tsv",
  "xml",
  "yml",
  "yaml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "log",
  "env",
  "gitignore",
  "dockerignore",
  "editorconfig",
  "svg",
  "html",
  "htm",
  "css",
  "scss",
  "less",
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "php",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "bat",
  "sql",
  "gcode",
  "nc",
  "ngc",
]);

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "tif", "tiff"]);
const VIDEO_EXTS = new Set(["mp4", "mov", "webm", "mkv", "avi", "m4v"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "flac", "aac", "ogg", "m4a", "aiff"]);
const CODE_EXTS = new Set([
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "c",
  "h",
  "cpp",
  "cs",
  "php",
  "sh",
  "sql",
  "vue",
  "svelte",
]);
const DOC_EXTS = new Set(["pdf", "doc", "docx", "rtf", "odt", "pages", "xls", "xlsx", "ppt", "pptx"]);
const ARCHIVE_EXTS = new Set(["zip", "7z", "rar", "tar", "gz", "tgz", "bz2", "xz"]);
const MODEL_EXTS = new Set(["obj", "fbx", "gltf", "glb", "blend", "dae", "ply"]);
const PRINT_EXTS = new Set(["stl", "3mf", "amf", "gcode", "bgcode", "ctb", "goo", "pwmx", "lys"]);

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  json: "application/json",
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

export function resolveSafePath(input: string): string {
  if (typeof input !== "string" || input.length === 0 || input.length > 4096) {
    throw new Error("Invalid path");
  }
  if (input.includes("\0")) throw new Error("Invalid path");
  return path.resolve(input.trim());
}

export function sanitizeName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Name is required");
  if (trimmed === "." || trimmed === "..") throw new Error("Invalid name");
  if (/[\\/]/.test(trimmed) || trimmed.includes("\0")) throw new Error("Invalid name");
  if (trimmed.length > 255) throw new Error("Name is too long");
  return trimmed;
}

export function extOf(name: string): string {
  const base = name.split("/").pop() ?? name;
  if (base.startsWith(".") && !base.slice(1).includes(".")) return "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

export function categoryOf(kind: FsKind, ext: string): FileCategory {
  if (kind === "dir") return "folder";
  if (IMAGE_EXTS.has(ext) || ext === "svg") return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (PRINT_EXTS.has(ext)) return "print";
  if (MODEL_EXTS.has(ext)) return "model";
  if (ARCHIVE_EXTS.has(ext)) return "archive";
  if (DOC_EXTS.has(ext)) return "document";
  if (CODE_EXTS.has(ext)) return "code";
  if (TEXT_EXTS.has(ext)) return "text";
  return "other";
}

export function mimeOf(ext: string): string {
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

export function isTextExt(ext: string): boolean {
  return TEXT_EXTS.has(ext) || ext === "svg";
}

export function isImageExt(ext: string): boolean {
  return IMAGE_EXTS.has(ext);
}

function parentOf(resolved: string): string | null {
  const parent = path.dirname(resolved);
  if (parent === resolved) return null;
  return parent;
}

async function toEntry(dir: string, name: string): Promise<FsEntry | null> {
  const full = path.join(dir, name);
  try {
    const st = await fs.lstat(full);
    let kind: FsKind = "other";
    if (st.isSymbolicLink()) kind = "link";
    else if (st.isDirectory()) kind = "dir";
    else if (st.isFile()) kind = "file";
    const ext = extOf(name);
    return {
      name,
      path: full,
      kind,
      ext,
      size: st.isFile() ? st.size : null,
      mtime: st.mtimeMs,
      category: categoryOf(kind === "link" && st.isDirectory() ? "dir" : kind, ext),
    };
  } catch {
    return null;
  }
}

async function addIfDir(drives: Drive[], id: string, dir: string, label: string, kind: Drive["kind"]) {
  try {
    const st = await fs.stat(dir);
    if (st.isDirectory()) {
      drives.push({ id, path: path.resolve(dir), label, kind });
    }
  } catch {
    /* missing */
  }
}

async function addChildren(drives: Drive[], parent: string, kind: Drive["kind"]) {
  try {
    const names = await fs.readdir(parent);
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const full = path.join(parent, name);
      try {
        const st = await fs.stat(full);
        if (st.isDirectory()) {
          drives.push({
            id: `${kind}-${name}`,
            path: path.resolve(full),
            label: name,
            kind,
          });
        }
      } catch {
        /* skip unreadable */
      }
    }
  } catch {
    /* parent missing */
  }
}

const PINNED_LETTERS = ["X", "Z"] as const;

function uniqueDrives(drives: Drive[]): Drive[] {
  const seen = new Set<string>();
  const out: Drive[] = [];
  for (const d of drives) {
    const key = d.path.replace(/[\\/]+$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

function winLetterPath(letter: string): string {
  return `${letter}:\\`;
}

function unixLetterCandidates(letter: string): string[] {
  const lower = letter.toLowerCase();
  const upper = letter.toUpperCase();
  return [
    `/mnt/${lower}`,
    `/mnt/${upper}`,
    `/media/${lower}`,
    `/media/${upper}`,
    `/Volumes/${upper}`,
    `/Volumes/${lower}`,
    `/Volumes/${upper}:`,
  ];
}

async function resolvePinnedLetter(letter: string): Promise<string> {
  if (process.platform === "win32") return winLetterPath(letter);
  for (const candidate of unixLetterCandidates(letter)) {
    try {
      const st = await fs.stat(candidate);
      if (st.isDirectory()) return path.resolve(candidate);
    } catch {
      /* keep looking */
    }
  }
  return winLetterPath(letter);
}

async function addPinnedLetters(drives: Drive[]) {
  const have = new Set(drives.map((d) => d.id.toUpperCase()));
  for (const letter of PINNED_LETTERS) {
    if (have.has(letter)) continue;
    const resolved = await resolvePinnedLetter(letter);
    drives.push({
      id: letter,
      path: resolved,
      label: `${letter}:`,
      kind: "volume",
    });
    have.add(letter);
  }
}

export async function listDrives(): Promise<Drive[]> {
  const drives: Drive[] = [];

  if (process.platform === "win32") {
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      const p = winLetterPath(letter);
      if (existsSync(p)) {
        drives.push({ id: letter, path: p, label: `${letter}:`, kind: "volume" });
      }
    }
    await addPinnedLetters(drives);
    await addIfDir(drives, "home", os.homedir(), "Home", "home");
    return uniqueDrives(drives);
  }

  await addIfDir(drives, "root", "/", "System", "system");
  await addIfDir(drives, "home", os.homedir(), "Home", "home");
  await addPinnedLetters(drives);
  if (process.platform === "darwin") {
    await addChildren(drives, "/Volumes", "volume");
  } else {
    await addChildren(drives, "/mnt", "volume");
    await addChildren(drives, "/media", "volume");
    await addIfDir(drives, "workspace", "/workspace", "Workspace", "project");
  }
  return uniqueDrives(drives);
}

export async function listEntries(dirPath: string, showHidden: boolean): Promise<DirListing> {
  const resolved = resolveSafePath(dirPath);
  const st = await fs.stat(resolved);
  if (!st.isDirectory()) throw new Error(`Not a folder: ${resolved}`);

  const names = await fs.readdir(resolved);
  const entries: FsEntry[] = [];
  for (const name of names) {
    if (!showHidden && name.startsWith(".")) continue;
    const entry = await toEntry(resolved, name);
    if (entry) entries.push(entry);
  }

  entries.sort((a, b) => {
    if (a.kind === "dir" && b.kind !== "dir") return -1;
    if (a.kind !== "dir" && b.kind === "dir") return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  return { path: resolved, parent: parentOf(resolved), entries };
}

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  "$recycle.bin",
  "system volume information",
  "windows",
  "program files",
  "program files (x86)",
  "programdata",
  "recovery",
]);
const HIDDEN_VCS_DIRS = new Set([".git", ".svn", ".hg"]);

export async function searchEntries(
  rootPath: string,
  query: string,
  showHidden: boolean,
): Promise<import("./types").SearchResult> {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) throw new Error("Type at least 2 characters");
  const root = resolveSafePath(rootPath);
  const hits: import("./types").SearchHit[] = [];
  let truncated = false;
  let visits = 0;
  const maxHits = 200;
  const maxVisits = 5000;
  const deadline = Date.now() + 8000;

  async function walk(dir: string): Promise<void> {
    if (truncated) return;
    if (Date.now() > deadline || visits >= maxVisits || hits.length >= maxHits) {
      truncated = true;
      return;
    }
    visits += 1;
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (truncated) return;
      if (!showHidden && name.startsWith(".")) continue;
      const lower = name.toLowerCase();
      const full = path.join(dir, name);
      let st;
      try {
        st = await fs.lstat(full);
      } catch {
        continue;
      }
      if (lower.includes(needle)) {
        const entry = await toEntry(dir, name);
        if (entry) hits.push({ ...entry, folder: dir });
        if (hits.length >= maxHits) {
          truncated = true;
          return;
        }
      }
      if (st.isDirectory() && !st.isSymbolicLink()) {
        if (SKIP_DIR_NAMES.has(lower)) continue;
        if (!showHidden && HIDDEN_VCS_DIRS.has(lower)) continue;
        await walk(full);
      }
    }
  }

  await walk(root);
  hits.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return { root, query: needle, hits, truncated };
}

export async function createFolder(parentPath: string, name: string): Promise<string> {
  const parent = resolveSafePath(parentPath);
  const dest = path.join(parent, sanitizeName(name));
  await fs.mkdir(dest, { recursive: false });
  return dest;
}

export async function renameEntry(fromPath: string, nextName: string): Promise<string> {
  const from = resolveSafePath(fromPath);
  const dest = path.join(path.dirname(from), sanitizeName(nextName));
  if (from === dest) return dest;
  await fs.rename(from, dest);
  return dest;
}

export async function removeEntry(targetPath: string): Promise<void> {
  const target = resolveSafePath(targetPath);
  const st = await fs.lstat(target);
  if (st.isDirectory()) {
    await fs.rm(target, { recursive: true, force: false });
  } else {
    await fs.unlink(target);
  }
}

export async function writeUpload(parentPath: string, filename: string, bytes: Uint8Array): Promise<string> {
  const parent = resolveSafePath(parentPath);
  const dest = path.join(parent, sanitizeName(filename));
  await fs.writeFile(dest, bytes);
  return dest;
}

export async function readTextPreview(
  filePath: string,
  maxBytes = 180_000,
): Promise<{ text: string; truncated: boolean; language: string | null }> {
  const resolved = resolveSafePath(filePath);
  const st = await fs.stat(resolved);
  if (!st.isFile()) throw new Error("Not a file");
  const ext = extOf(resolved);
  if (!isTextExt(ext) && st.size > 0) {
    const head = await readHead(resolved, 512);
    if (head.includes(0)) throw new Error("Binary file");
  }
  const handle = await fs.open(resolved, "r");
  try {
    const size = Math.min(st.size, maxBytes + 1);
    const buf = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buf, 0, size, 0);
    const slice = buf.subarray(0, Math.min(bytesRead, maxBytes));
    return {
      text: slice.toString("utf8"),
      truncated: st.size > maxBytes,
      language: ext || null,
    };
  } finally {
    await handle.close();
  }
}

async function readHead(filePath: string, n: number): Promise<Buffer> {
  const handle = await fs.open(filePath, "r");
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await handle.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function openFileForRead(filePath: string) {
  const resolved = resolveSafePath(filePath);
  const st = await fs.stat(resolved);
  if (!st.isFile()) throw new Error("Not a file");
  const ext = extOf(resolved);
  return {
    path: resolved,
    size: st.size,
    mime: mimeOf(ext),
    name: path.basename(resolved),
    stream: createReadStream(resolved),
  };
}

/**
 * Paste cut or copied entries into `destPath`.
 * Cut moves (rename, or copy then remove across disks). Copy never overwrites: names get " (copy)".
 */
export async function pasteEntries(
  sources: string[],
  destPath: string,
  mode: "cut" | "copy",
): Promise<{ pasted: string[] }> {
  const dest = resolveSafePath(destPath);
  const destStat = await fs.stat(dest);
  if (!destStat.isDirectory()) throw new Error("Paste into a folder");
  const taken = new Set(await fs.readdir(dest));
  const pasted: string[] = [];
  for (const raw of sources) {
    const from = resolveSafePath(raw);
    const st = await fs.lstat(from);
    if (st.isDirectory() && isSameOrInside(dest, from, path.sep)) {
      throw new Error(`Cannot paste “${path.basename(from)}” into itself`);
    }
    if (mode === "cut" && path.dirname(from) === dest) {
      pasted.push(from);
      continue;
    }
    const name = uniquePasteName(path.basename(from), taken);
    taken.add(name);
    const target = path.join(dest, name);
    if (mode === "cut") {
      try {
        await fs.rename(from, target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
        await fs.cp(from, target, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
        await fs.rm(from, { recursive: true, force: false });
      }
    } else {
      await fs.cp(from, target, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    }
    pasted.push(target);
  }
  return { pasted };
}
