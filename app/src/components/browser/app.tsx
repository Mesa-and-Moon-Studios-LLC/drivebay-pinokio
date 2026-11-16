import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowUp,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Columns2,
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Home,
  Link2,
  Loader2,
  LogOut,
  Menu,
  Pencil,
  RefreshCw,
  Scissors,
  Search,
  Send,
  Settings,
  Share2,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { signOut } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { RedirectToSignIn } from "@/lib/auth/gates";
import { emailToUsername } from "@/lib/files/identity";
import {
  createFolder,
  deleteEntry,
  getBrowserActions,
  getPreview,
  listDrives,
  listEntries,
  pasteEntries,
  readFileBase64,
  renameEntry,
  searchFiles,
  uploadFile,
} from "@/lib/files/api.functions";
import { isAndroidApp, settingsOnThisPc } from "@/lib/files/client-surface.mjs";
import { snapshotUploadFiles } from "@/lib/files/upload-files.mjs";
import { clipboardLabel, pasteProblem, type Clip } from "@/lib/files/clipboard.mjs";
import { defaultStartPath, formatBytes, formatWhen, splitPath } from "@/lib/files/format";
import type { DirListing, Drive, FileCategory, FsEntry, PreviewPayload, SearchHit } from "@/lib/files/types";
import { FileGlyph } from "@/components/file-icon";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type ViewMode = "list" | "grid";
type SortMode = "name" | "type" | "size" | "date";

const CATEGORY_ORDER: FileCategory[] = [
  "folder",
  "image",
  "video",
  "audio",
  "document",
  "code",
  "text",
  "archive",
  "model",
  "print",
  "other",
];

const CATEGORY_LABEL: Record<FileCategory, string> = {
  folder: "Folders",
  image: "Images",
  video: "Videos",
  audio: "Audio",
  document: "Documents",
  code: "Code",
  text: "Text",
  archive: "Archives",
  model: "Models",
  print: "3D print",
  other: "Other",
};

function sortEntries(entries: FsEntry[], mode: SortMode): FsEntry[] {
  const copy = [...entries];
  copy.sort((a, b) => {
    // Folders first unless sorting purely by size/date among mixed
    if (mode === "name" || mode === "type") {
      if (a.kind === "dir" && b.kind !== "dir") return -1;
      if (a.kind !== "dir" && b.kind === "dir") return 1;
    }
    switch (mode) {
      case "type": {
        const ca = CATEGORY_ORDER.indexOf(a.category);
        const cb = CATEGORY_ORDER.indexOf(b.category);
        if (ca !== cb) return ca - cb;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      }
      case "size": {
        const sa = a.size ?? -1;
        const sb = b.size ?? -1;
        if (sa !== sb) return sb - sa;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      }
      case "date": {
        const ma = a.mtime ?? 0;
        const mb = b.mtime ?? 0;
        if (ma !== mb) return mb - ma;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      }
      case "name":
      default:
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    }
  });
  return copy;
}

function groupEntries(entries: FsEntry[]): { category: FileCategory; items: FsEntry[] }[] {
  const map = new Map<FileCategory, FsEntry[]>();
  for (const e of entries) {
    const list = map.get(e.category) ?? [];
    list.push(e);
    map.set(e.category, list);
  }
  return CATEGORY_ORDER.filter((c) => map.has(c)).map((category) => ({
    category,
    items: map.get(category) ?? [],
  }));
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message === "Unauthorized" ? "Session expired" : err.message;
  return "Something went wrong";
}

const CLIP_KEY = "drivebay-clipboard";

function readStoredClip(): Clip | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(CLIP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Clip;
    return parsed && Array.isArray(parsed.items) && parsed.items.length ? parsed : null;
  } catch {
    return null;
  }
}

function pathSep(p: string): string {
  return /^[a-z]:[\\/]/i.test(p) || p.startsWith("\\\\") ? "\\" : "/";
}

type NativeBridge = {
  download?: (url: string, fileName: string, size: string) => void;
  shareFiles?: (json: string) => void;
};

function nativeBridge(): NativeBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { DrivebayNative?: NativeBridge }).DrivebayNative;
}

function downloadUrl(path: string): string {
  return new URL(`/api/download?path=${encodeURIComponent(path)}`, window.location.href).toString();
}

/** Long press on touch screens, right click everywhere. */
function useEntryMenu(onMenu: (entry: FsEntry, x: number, y: number) => void) {
  const timer = useRef<number | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  return {
    /** True once after a long press, so the tap that ends it does not also open the item. */
    consumeLongPress() {
      const was = fired.current;
      fired.current = false;
      return was;
    },
    bind(entry: FsEntry) {
      return {
        onContextMenu(e: React.MouseEvent) {
          e.preventDefault();
          // A touch hold can raise contextmenu as well as our timer. Open once and swallow the tap.
          const holding = timer.current !== null;
          clear();
          if (holding) fired.current = true;
          else if (fired.current) return;
          onMenu(entry, e.clientX, e.clientY);
        },
        onTouchStart(e: React.TouchEvent) {
          const t = e.touches[0];
          if (!t) return;
          fired.current = false;
          start.current = { x: t.clientX, y: t.clientY };
          clear();
          timer.current = window.setTimeout(() => {
            fired.current = true;
            if (start.current) onMenu(entry, start.current.x, start.current.y);
          }, 480);
        },
        onTouchMove(e: React.TouchEvent) {
          const t = e.touches[0];
          if (!t || !start.current) return;
          if (Math.abs(t.clientX - start.current.x) > 10 || Math.abs(t.clientY - start.current.y) > 10) clear();
        },
        onTouchEnd() {
          clear();
        },
        onTouchCancel() {
          clear();
        },
      };
    },
  };
}

type EntryMenuApi = ReturnType<typeof useEntryMenu>;

export function FileBrowserApp() {
  const navigate = useNavigate();
  const { user, isPending } = useCurrentUserState();
  const [drives, setDrives] = useState<Drive[]>([]);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [path, setPath] = useState<string>("");
  const [showHidden, setShowHidden] = useState(false);
  const [query, setQuery] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<ViewMode>("list");
  const [sortMode, setSortMode] = useState<SortMode>("name");
  const [groupByType, setGroupByType] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewPayload | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [mobilePreview, setMobilePreview] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pathEdit, setPathEdit] = useState(false);
  const [pathDraft, setPathDraft] = useState("");
  const [dragging, setDragging] = useState(false);
  const [marked, setMarked] = useState<Map<string, FsEntry>>(() => new Map());
  const [clip, setClipState] = useState<Clip | null>(() => readStoredClip());
  const [menuAt, setMenuAt] = useState<{ x: number; y: number; entry: FsEntry } | null>(null);
  const [deleteTargets, setDeleteTargets] = useState<FsEntry[]>([]);
  const entryMenu = useEntryMenu((entry, x, y) => {
    setSelected(entry.path);
    setMenuAt({ entry, x, y });
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewUrlRef = useRef<string | null>(null);
  const [serverLock, setServerLock] = useState<{
    allowDelete: boolean;
    allowRename: boolean;
    allowMove: boolean;
    allowCreateFolder: boolean;
    allowUpload: boolean;
    maxUploadMb: number;
  } | null>(null);

  const selectedEntry = listing?.entries.find((e) => e.path === selected) ?? null;
  const crumbs = useMemo(() => (listing ? splitPath(listing.path) : []), [listing]);

  const visible = useMemo(() => {
    let entries: FsEntry[] = searchHits ?? listing?.entries ?? [];
    if (!searchHits) {
      const q = query.trim().toLowerCase();
      if (q) entries = entries.filter((e) => e.name.toLowerCase().includes(q));
    }
    return sortEntries(entries, sortMode);
  }, [listing, query, searchHits, sortMode]);

  const groupedVisible = useMemo(
    () => (groupByType ? groupEntries(visible) : null),
    [groupByType, visible],
  );

  const runSearch = useCallback(async (raw = query) => {
    const q = raw.trim();
    if (q.length < 2) {
      toast.error("Type at least 2 characters");
      return;
    }
    const root = listing?.path || path;
    if (!root) return;
    setSearching(true);
    try {
      const result = await searchFiles({ data: { root, query: q, showHidden } });
      setSearchHits(result.hits);
      setSearchTruncated(result.truncated);
      setSelected(result.hits[0]?.path ?? null);
      if (result.hits.length === 0) toast.message(`No matches for “${q}”`);
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setSearching(false);
    }
  }, [query, listing, path, showHidden]);

  const clearSearch = useCallback(() => {
    setSearchHits(null);
    setSearchTruncated(false);
    setQuery("");
  }, []);

  useEffect(() => {
    if (!searchHits) return;
    void runSearch();
    // Re-run after the hidden-files eye is toggled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden]);

  useEffect(() => {
    function onHotkey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
        searchRef.current?.focus();
        searchRef.current?.select();
      }
      if (e.key === "Escape" && searchHits) {
        e.preventDefault();
        clearSearch();
      }
    }
    window.addEventListener("keydown", onHotkey);
    return () => window.removeEventListener("keydown", onHotkey);
  }, [searchHits, clearSearch]);

  const loadDrives = useCallback(async () => {
    const next = await listDrives();
    setDrives(next);
    return next;
  }, []);

  useEffect(() => {
    let alive = true;
    getBrowserActions()
      .then((s) => {
        if (!alive) return;
        setServerLock({
          allowDelete: s.allowDelete !== false,
          allowRename: s.allowRename !== false,
          allowMove: s.allowMove !== false,
          allowCreateFolder: s.allowCreateFolder !== false,
          allowUpload: s.allowUpload !== false,
          maxUploadMb: typeof s.maxUploadMb === "number" ? s.maxUploadMb : 512,
        });
      })
      .catch(() => {
        if (alive) {
          setServerLock({
            allowDelete: true,
            allowRename: true,
            allowMove: true,
            allowCreateFolder: true,
            allowUpload: true,
            maxUploadMb: 512,
          });
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  const openPath = useCallback(
    async (nextPath: string, opts?: { select?: string | null; silent?: boolean }) => {
      setLoading(true);
      try {
        const next = await listEntries({ data: { path: nextPath, showHidden } });
        setListing(next);
        setPath(next.path);
        setSelected(opts?.select === undefined ? null : opts.select);
        setPreview(null);
        setPreviewUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return null;
        });
        return true;
      } catch (err) {
        if (!opts?.silent) toast.error(errMessage(err));
        return false;
      } finally {
        setLoading(false);
      }
    },
    [showHidden],
  );

  useEffect(() => {
    const w = window as Window & { __drivebayAndroidBack?: () => boolean };
    w.__drivebayAndroidBack = () => {
      if (menuAt) {
        setMenuAt(null);
        return true;
      }
      if (marked.size) {
        setMarked(new Map());
        return true;
      }
      if (renameOpen) {
        setRenameOpen(false);
        return true;
      }
      if (deleteOpen) {
        setDeleteOpen(false);
        return true;
      }
      if (folderOpen) {
        setFolderOpen(false);
        return true;
      }
      if (mobilePreview) {
        setMobilePreview(false);
        return true;
      }
      if (mobileNav) {
        setMobileNav(false);
        return true;
      }
      if (searchHits) {
        clearSearch();
        return true;
      }
      if (listing?.parent) {
        void openPath(listing.parent);
        return true;
      }
      return false;
    };
    const uploadWindow = window as Window & { __drivebayUploadFinished?: () => void };
    uploadWindow.__drivebayUploadFinished = () => {
      const current = listing?.path;
      if (current) void openPath(current);
    };
    return () => {
      delete w.__drivebayAndroidBack;
      delete uploadWindow.__drivebayUploadFinished;
    };
  }, [
    menuAt,
    marked,
    renameOpen,
    deleteOpen,
    folderOpen,
    mobilePreview,
    mobileNav,
    searchHits,
    listing,
    clearSearch,
    openPath,
  ]);

  useEffect(() => {
    if (isPending || !user) return;
    let alive = true;
    (async () => {
      try {
        const nextDrives = await loadDrives();
        if (!alive) return;
        const candidates = [
          defaultStartPath(nextDrives),
          nextDrives.find((d) => d.kind === "home")?.path ?? null,
          nextDrives.find((d) => d.kind === "volume")?.path ?? null,
          nextDrives[0]?.path ?? null,
        ].filter((p, i, arr): p is string => Boolean(p) && arr.indexOf(p) === i);

        const tryOpen = async (target: string, silent: boolean) => {
          if (await openPath(target, { silent })) return true;
          await new Promise((resolve) => setTimeout(resolve, 280));
          if (!alive) return false;
          return openPath(target, { silent });
        };

        for (let i = 0; i < candidates.length; i += 1) {
          if (!alive) return;
          const last = i === candidates.length - 1;
          const ok = await tryOpen(candidates[i] ?? "/", !last);
          if (ok) return;
        }
      } catch (err) {
        if (alive) toast.error(errMessage(err));
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPending, user?.id, showHidden]);

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    };
  }, []);

  useEffect(() => {
    previewUrlRef.current = previewUrl;
  }, [previewUrl]);

  async function inspect(entry: FsEntry) {
    setSelected(entry.path);
    if (entry.kind === "dir") return;
    setPreview(null);
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    try {
      const payload = await getPreview({ data: { path: entry.path } });
      setPreview(payload);
      if (payload.kind === "image") {
        const file = await readFileBase64({ data: { path: entry.path } });
        const bin = Uint8Array.from(atob(file.contentBase64), (c) => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bin], { type: file.mime }));
        setPreviewUrl(url);
      }
    } catch (err) {
      toast.error(errMessage(err));
    }
  }

  async function activate(entry: FsEntry) {
    if (entry.kind === "dir" || entry.kind === "link") {
      setMobileNav(false);
      setSearchHits(null);
      setSearchTruncated(false);
      await openPath(entry.path);
      return;
    }
    await inspect(entry);
    setMobilePreview(true);
  }

  async function downloadSelected() {
    if (!selectedEntry || selectedEntry.kind === "dir") return;
    if (nativeBridge()?.download) {
      void downloadEntry(selectedEntry);
      return;
    }
    setBusy(true);
    try {
      // Stream large files via /api/download (no base64 size ceiling).
      await downloadEntry(selectedEntry);
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleUpload(files: FileList | File[]) {
    if (!listing) return;
    if (serverLock && !serverLock.allowUpload) {
      toast.error("Upload is turned off in Settings on the PC that runs Drivebay.");
      return;
    }
    const list = Array.from(files);
    if (list.length === 0) return;
    const maxMb = serverLock?.maxUploadMb ?? 512;
    const maxBytes = maxMb * 1024 * 1024;
    setBusy(true);
    try {
      for (const file of list) {
        if (file.size > maxBytes) {
          toast.error(`${file.name} is larger than ${maxMb} MB`);
          continue;
        }
        const buf = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        for (const byte of buf) binary += String.fromCharCode(byte);
        await uploadFile({
          data: {
            parent: listing.path,
            name: file.name,
            contentBase64: btoa(binary),
          },
        });
      }
      toast.success(list.length === 1 ? "Uploaded" : `Uploaded ${list.length} files`);
      await openPath(listing.path);
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateFolder() {
    if (!listing || !folderName.trim()) return;
    if (serverLock && !serverLock.allowCreateFolder) {
      toast.error("Create folder is locked on the server.");
      return;
    }
    setBusy(true);
    try {
      await createFolder({ data: { parent: listing.path, name: folderName.trim() } });
      setFolderOpen(false);
      setFolderName("");
      await openPath(listing.path);
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleRename() {
    if (!selectedEntry || !renameValue.trim()) return;
    if (serverLock && !serverLock.allowRename) {
      toast.error("Rename is locked on the server.");
      return;
    }
    setBusy(true);
    try {
      const next = await renameEntry({ data: { path: selectedEntry.path, name: renameValue.trim() } });
      setRenameOpen(false);
      await openPath(listing?.path ?? path, { select: next.path });
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    const targets = deleteTargets.length ? deleteTargets : selectedEntry ? [selectedEntry] : [];
    if (!targets.length) return;
    if (serverLock && !serverLock.allowDelete) {
      toast.error("Delete is locked on the server.");
      return;
    }
    setBusy(true);
    try {
      for (const target of targets) {
        await deleteEntry({ data: { path: target.path } });
      }
      setDeleteOpen(false);
      setDeleteTargets([]);
      setMarked(new Map());
      if (clip && clip.items.some((item) => targets.some((t) => t.path === item.path))) setClip(null);
      await openPath(listing?.path ?? path);
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function startUpload() {
    const native = (window as Window & { DrivebayNative?: { pickUpload?: (parent: string) => void } }).DrivebayNative;
    const parent = listing?.path;
    if (native?.pickUpload && parent) {
      native.pickUpload(parent);
      return;
    }
    fileInputRef.current?.click();
  }

  function setClip(next: Clip | null) {
    setClipState(next);
    try {
      if (next) window.sessionStorage.setItem(CLIP_KEY, JSON.stringify(next));
      else window.sessionStorage.removeItem(CLIP_KEY);
    } catch {
      // Private mode. The bar still works for this page.
    }
  }

  /** The marked items when the entry is one of them, otherwise just the entry. */
  function targetsFor(entry: FsEntry | null): FsEntry[] {
    if (entry && marked.has(entry.path)) return Array.from(marked.values());
    if (entry) return [entry];
    if (marked.size) return Array.from(marked.values());
    return selectedEntry ? [selectedEntry] : [];
  }

  function toggleMark(entry: FsEntry) {
    setMarked((prev) => {
      const next = new Map(prev);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.set(entry.path, entry);
      return next;
    });
  }

  function putOnClipboard(mode: "cut" | "copy", entries: FsEntry[]) {
    if (!entries.length) return;
    if (mode === "cut" && serverLock && !serverLock.allowMove) {
      toast.error("Moving files is turned off in Settings on the PC that runs Drivebay.");
      return;
    }
    if (mode === "copy" && serverLock && !serverLock.allowUpload) {
      toast.error("Copying files is turned off in Settings on the PC that runs Drivebay.");
      return;
    }
    const next: Clip = {
      mode,
      items: entries.map((e) => ({ path: e.path, name: e.name, kind: e.kind })),
      from: listing?.path ?? path,
    };
    setClip(next);
    setMarked(new Map());
    toast.message(`${clipboardLabel(next)}. Open a folder and tap Paste here.`);
  }

  async function pasteInto(dest: string) {
    if (!clip) return;
    const problem = pasteProblem(clip, dest, pathSep(dest));
    if (problem) {
      toast.error(problem);
      return;
    }
    setBusy(true);
    try {
      const result = await pasteEntries({
        data: { sources: clip.items.map((i) => i.path), dest, mode: clip.mode },
      });
      const n = result.pasted.length;
      toast.success(`${clip.mode === "copy" ? "Copied" : "Moved"} ${n} ${n === 1 ? "item" : "items"}`);
      setClip(null);
      const current = listing?.path ?? path;
      await openPath(current, { select: dest === current ? result.pasted[0] ?? null : null });
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function downloadEntry(entry: FsEntry) {
    if (entry.kind === "dir") return;
    const native = nativeBridge();
    if (native?.download) {
      native.download(downloadUrl(entry.path), entry.name, String(entry.size ?? 0));
      return;
    }
    const res = await fetch(`/api/download?path=${encodeURIComponent(entry.path)}`, { credentials: "include" });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text || `Download failed (${res.status})`);
    }
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = entry.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  }

  const canShareFiles =
    Boolean(nativeBridge()?.shareFiles) ||
    (typeof navigator !== "undefined" && typeof navigator.share === "function" && typeof navigator.canShare === "function");

  /** Send to: the Android share sheet, the system share sheet in the browser, or a download. */
  async function sendTo(entries: FsEntry[]) {
    const files = entries.filter((e) => e.kind !== "dir");
    if (!files.length) {
      toast.error("Send to works on files. Open the folder and pick the files inside.");
      return;
    }
    if (files.length < entries.length) toast.message("Folders were skipped. Send to shares files.");
    const native = nativeBridge();
    if (native?.shareFiles) {
      native.shareFiles(JSON.stringify(files.map((f) => ({ url: downloadUrl(f.path), name: f.name, size: f.size ?? 0 }))));
      return;
    }
    if (typeof navigator.share === "function" && typeof navigator.canShare === "function") {
      const total = files.reduce((sum, f) => sum + (f.size ?? 0), 0);
      if (total > 256 * 1024 * 1024) {
        toast.error("That is too large to share from the browser. Use Download instead.");
        return;
      }
      setBusy(true);
      try {
        const shared: File[] = [];
        for (const f of files) {
          const res = await fetch(`/api/download?path=${encodeURIComponent(f.path)}`, { credentials: "include" });
          if (!res.ok) throw new Error(`Could not read ${f.name}`);
          const blob = await res.blob();
          shared.push(new File([blob], f.name, { type: blob.type || "application/octet-stream" }));
        }
        if (!navigator.canShare({ files: shared })) {
          toast.message("This browser cannot share these files. Downloading instead.");
          for (const f of files) await downloadEntry(f);
          return;
        }
        await navigator.share({ files: shared, title: files.length === 1 ? files[0]?.name : `${files.length} files` });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        toast.error(errMessage(err));
      } finally {
        setBusy(false);
      }
      return;
    }
    toast.message("This browser has no share sheet. Downloading instead.");
    try {
      for (const f of files) await downloadEntry(f);
    } catch (err) {
      toast.error(errMessage(err));
    }
  }

  async function copyPaths(entries: FsEntry[]) {
    const text = entries.map((e) => e.path).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.success(entries.length === 1 ? "Path copied" : "Paths copied");
    } catch {
      toast.error("The clipboard is not available here.");
    }
  }

  function askRename(entry: FsEntry) {
    setSelected(entry.path);
    setRenameValue(entry.name);
    setRenameOpen(true);
  }

  function askDelete(entries: FsEntry[]) {
    if (!entries.length) return;
    setDeleteTargets(entries);
    setDeleteOpen(true);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "x" && (selectedEntry || marked.size)) {
      e.preventDefault();
      putOnClipboard("cut", targetsFor(selectedEntry));
      return;
    }
    if (mod && e.key.toLowerCase() === "c" && (selectedEntry || marked.size)) {
      e.preventDefault();
      putOnClipboard("copy", targetsFor(selectedEntry));
      return;
    }
    if (mod && e.key.toLowerCase() === "v" && clip && listing) {
      e.preventDefault();
      void pasteInto(listing.path);
      return;
    }
    if (e.key === "Backspace" && listing?.parent) {
      e.preventDefault();
      void openPath(listing.parent);
    }
    if (e.key === "Enter" && selectedEntry) {
      e.preventDefault();
      void activate(selectedEntry);
    }
    if ((e.key === "Delete" || e.key === "Backspace") && (e.metaKey || e.ctrlKey) && selectedEntry && serverLock?.allowDelete !== false) {
      e.preventDefault();
      setDeleteOpen(true);
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (visible.length === 0) return;
      const idx = visible.findIndex((x) => x.path === selected);
      const next =
        e.key === "ArrowDown"
          ? visible[Math.min(visible.length - 1, (idx < 0 ? -1 : idx) + 1)]
          : visible[Math.max(0, (idx < 0 ? 1 : idx) - 1)];
      if (next) void inspect(next);
    }
  }

  if (isPending) {
    return (
      <div className="grid min-h-dvh place-items-center bg-bg">
        <Loader2 className="size-6 animate-spin text-fg-subtle" />
      </div>
    );
  }
  if (!user) return <RedirectToSignIn />;

  const ownerName = user.displayName || emailToUsername(user.primaryEmail);
  const showAppSettings = isAndroidApp();
  const showServerSettings = settingsOnThisPc(typeof window === "undefined" ? "" : window.location.hostname);

  function openSurfaceSettings() {
    if (showAppSettings) {
      const native = (window as Window & { DrivebayNative?: { openAppSettings?: () => void } }).DrivebayNative;
      native?.openAppSettings?.();
      setMobileNav(false);
      return;
    }
    if (showServerSettings) {
      setMobileNav(false);
      void navigate({ to: "/settings" });
    }
  }

  const nav = (
    <DriveNav
      drives={drives}
      current={listing?.path ?? path}
      onOpen={(p) => {
        setMobileNav(false);
        void openPath(p);
      }}
    />
  );

  const current = listing?.path ?? path;
  const selectionTargets = targetsFor(selectedEntry);
  const hasTargets = selectionTargets.length > 0;
  const fileTargets = selectionTargets.filter((e) => e.kind !== "dir");
  const allowMove = serverLock?.allowMove !== false;
  const allowCopy = serverLock?.allowUpload !== false;
  const pasteBlocked = clip && current ? pasteProblem(clip, current, pathSep(current)) : "Nothing to paste";
  const menuTargets = menuAt ? targetsFor(menuAt.entry) : [];
  const narrow = typeof window !== "undefined" && window.innerWidth < 640;

  function onEntryClick(entry: FsEntry, e: React.MouseEvent, openOnTap: boolean) {
    if (entryMenu.consumeLongPress()) {
      e.preventDefault();
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      toggleMark(entry);
      setSelected(entry.path);
      return;
    }
    if (marked.size) {
      toggleMark(entry);
      return;
    }
    if (openOnTap) void activate(entry);
    else void inspect(entry);
  }

  const listProps = {
    selected,
    marked,
    clipPaths: clip?.mode === "cut" ? new Set(clip.items.map((i) => i.path)) : undefined,
    entryMenu,
    onClickEntry: onEntryClick,
    onOpen: (e: FsEntry) => void activate(e),
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-bg text-fg" onKeyDown={onKeyDown} tabIndex={0}>
      {/* Main bar, menu bar and paste bar stay pinned. Only the file list below them scrolls. */}
      <div className="sticky top-0 z-30 shrink-0 bg-bg" data-testid="top-bars">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 md:px-4">
        <Button
          variant="ghost"
          size="icon-sm"
          className="md:hidden"
          onClick={() => setMobileNav(true)}
          aria-label="Open drives"
        >
          <Menu className="size-4" />
        </Button>
        <div className="hidden items-center gap-2 md:flex">
          <HardDrive className="size-4 text-fg-muted" strokeWidth={1.7} />
          <span className="font-mono text-[11px] tracking-[0.16em] text-fg-subtle uppercase">
            Drivebay
          </span>
        </div>
        <Separator orientation="vertical" className="mx-1 hidden h-5 md:block" />
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <IconBtn label="Up" disabled={!listing?.parent} onClick={() => listing?.parent && void openPath(listing.parent)}>
            <ArrowUp />
          </IconBtn>
          <IconBtn label="Refresh" onClick={() => listing && void openPath(listing.path)}>
            <RefreshCw />
          </IconBtn>
          {pathEdit ? (
            <form
              className="min-w-0 flex-1"
              onSubmit={(e) => {
                e.preventDefault();
                setPathEdit(false);
                if (pathDraft.trim()) void openPath(pathDraft.trim());
              }}
            >
              <Input
                autoFocus
                value={pathDraft}
                onChange={(e) => setPathDraft(e.target.value)}
                onBlur={() => setPathEdit(false)}
                className="h-8 font-mono text-xs"
                spellCheck={false}
              />
            </form>
          ) : (
            <button
              type="button"
              onClick={() => {
                setPathDraft(listing?.path ?? path);
                setPathEdit(true);
              }}
              className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden rounded-sm px-1.5 py-1 text-left hover:bg-bg-subtle"
            >
              {crumbs.map((c, i) => (
                <span key={c.path} className="flex min-w-0 items-center gap-1">
                  {i > 0 && <ChevronRight className="size-3 shrink-0 text-fg-subtle" />}
                  <span
                    className={cn(
                      "truncate font-mono text-xs",
                      i === crumbs.length - 1 ? "text-fg" : "text-fg-muted",
                    )}
                    onClick={(e) => {
                      e.stopPropagation();
                      void openPath(c.path);
                    }}
                  >
                    {c.label}
                  </span>
                </span>
              ))}
            </button>
          )}
        </div>
        <div className={cn("min-w-0", searchOpen || searchHits ? "flex flex-1" : "hidden w-44 sm:flex sm:w-52")}>
          <form
            className="relative w-full"
            onSubmit={(e) => {
              e.preventDefault();
              void runSearch();
            }}
          >
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-subtle" />
            <Input
              ref={searchRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (searchHits) setSearchHits(null);
              }}
              placeholder="Search this folder"
              className="h-8 pr-8 pl-8 text-xs"
              aria-label="Search files"
            />
            {query ? (
              <button
                type="button"
                className="absolute top-1/2 right-1.5 -translate-y-1/2 text-fg-subtle hover:text-fg"
                onClick={clearSearch}
                aria-label="Clear search"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </form>
        </div>
        <span className={searchOpen || searchHits ? "hidden sm:inline-flex" : "sm:hidden"}>
          <IconBtn
            label="Search"
            onClick={() => {
              setSearchOpen(true);
              queueMicrotask(() => searchRef.current?.focus());
            }}
          >
            <Search />
          </IconBtn>
        </span>
        <div className="hidden items-center gap-2 pl-1 md:flex">
          <span className="max-w-28 truncate text-xs text-fg-muted">{ownerName}</span>
          {showAppSettings ? (
            <Button variant="ghost" size="icon-sm" aria-label="App settings" onClick={openSurfaceSettings}>
              <Settings className="size-3.5" />
            </Button>
          ) : showServerSettings ? (
            <Button variant="ghost" size="icon-sm" aria-label="Settings" onClick={openSurfaceSettings}>
              <Settings className="size-3.5" />
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={() => void signOut("/login")}>
            <LogOut className="size-3.5" />
            Lock
          </Button>
        </div>
      </header>

      <nav
        className="flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border px-2 md:px-3"
        aria-label="Menu bar"
        data-testid="menu-bar"
      >
        <DropdownMenu>
          <MenuBarTrigger label="File" />
          <DropdownMenuContent align="start">
            <DropdownMenuItem disabled={serverLock?.allowCreateFolder === false} onSelect={() => setFolderOpen(true)}>
              <FolderPlus />
              New folder
            </DropdownMenuItem>
            {serverLock?.allowUpload ? (
              <DropdownMenuItem onSelect={() => startUpload()}>
                <Upload />
                Upload
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!selectedEntry || selectedEntry.kind === "dir"}
              onSelect={() => void downloadSelected()}
            >
              <Download />
              Download
            </DropdownMenuItem>
            <SendToSub
              disabled={fileTargets.length === 0}
              canShare={canShareFiles}
              onShare={() => void sendTo(selectionTargets)}
              onDownload={() => void Promise.all(fileTargets.map((f) => downloadEntry(f))).catch((err) => toast.error(errMessage(err)))}
              onCopyPath={() => void copyPaths(selectionTargets)}
            />
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => listing && void openPath(listing.path)}>
              <RefreshCw />
              Refresh
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <MenuBarTrigger label="Edit" />
          <DropdownMenuContent align="start">
            <DropdownMenuItem disabled={!hasTargets || !allowMove} onSelect={() => putOnClipboard("cut", selectionTargets)}>
              <Scissors />
              Cut
              <DropdownMenuShortcut>Ctrl X</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!hasTargets || !allowCopy} onSelect={() => putOnClipboard("copy", selectionTargets)}>
              <Copy />
              Copy
              <DropdownMenuShortcut>Ctrl C</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={Boolean(pasteBlocked) || busy} onSelect={() => listing && void pasteInto(listing.path)}>
              <ClipboardPaste />
              Paste here
              <DropdownMenuShortcut>Ctrl V</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {serverLock?.allowRename || serverLock?.allowMove ? (
              <DropdownMenuItem
                disabled={!selectedEntry || selectionTargets.length !== 1}
                onSelect={() => selectedEntry && askRename(selectedEntry)}
              >
                <Pencil />
                Rename
              </DropdownMenuItem>
            ) : null}
            {serverLock?.allowDelete ? (
              <DropdownMenuItem danger disabled={!hasTargets} onSelect={() => askDelete(selectionTargets)}>
                <Trash2 />
                Delete
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={visible.length === 0}
              onSelect={() => setMarked(new Map(visible.map((e) => [e.path, e] as const)))}
            >
              <CheckSquare />
              Select all
            </DropdownMenuItem>
            <DropdownMenuItem disabled={marked.size === 0} onSelect={() => setMarked(new Map())}>
              <X />
              Clear selection
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <MenuBarTrigger label="View" />
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Layout</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={view} onValueChange={(v) => setView(v as ViewMode)}>
              <DropdownMenuRadioItem value="list">List</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="grid">Grid</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem checked={showHidden} onCheckedChange={(v) => setShowHidden(Boolean(v))}>
              Show hidden files
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <MenuBarTrigger label="Organize" />
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Sort by</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={sortMode} onValueChange={(v) => setSortMode(v as SortMode)}>
              <DropdownMenuRadioItem value="name">Name</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="type">Type</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="size">Size</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="date">Date modified</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem checked={groupByType} onCheckedChange={(v) => setGroupByType(Boolean(v))}>
              Group by type
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="ml-auto flex shrink-0 items-center gap-2 pl-2 text-xs text-fg-subtle">
          {marked.size ? (
            <button type="button" className="rounded-sm px-1.5 py-1 text-fg hover:bg-bg-subtle" onClick={() => setMarked(new Map())}>
              {marked.size} selected ✕
            </button>
          ) : null}
          <span className="hidden sm:inline">
            {searching
              ? "Searching…"
              : searchHits
                ? `${searchHits.length} match${searchHits.length === 1 ? "" : "es"}${searchTruncated ? "+" : ""}`
                : `${visible.length} ${visible.length === 1 ? "item" : "items"}`}
          </span>
        </div>
      </nav>

      {clip ? (
        <div
          className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border bg-bg-subtle px-3 py-1.5 text-sm md:px-4"
          role="status"
          data-testid="paste-bar"
        >
          {clip.mode === "copy" ? <Copy className="size-4 shrink-0 text-fg-muted" /> : <Scissors className="size-4 shrink-0 text-fg-muted" />}
          <span className="min-w-0 flex-1 truncate">
            <span className="font-medium">{clipboardLabel(clip)}</span>
            <span className="text-fg-muted">
              {" · "}
              {clip.items.length === 1 ? clip.items[0]?.name : `${clip.items[0]?.name} and ${clip.items.length - 1} more`}
            </span>
          </span>
          <Button
            size="sm"
            disabled={busy || Boolean(pasteBlocked)}
            title={pasteBlocked || undefined}
            onClick={() => listing && void pasteInto(listing.path)}
          >
            {busy ? <Loader2 className="animate-spin" /> : <ClipboardPaste />}
            Paste here
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setClip(null)}>
            Cancel
          </Button>
        </div>
      ) : null}
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="hidden w-56 shrink-0 overflow-hidden border-r border-border md:flex md:flex-col">
          {nav}
        </aside>

        <section
          className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (e.dataTransfer.files.length && serverLock?.allowUpload) {
              void handleUpload(e.dataTransfer.files);
            }
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const input = e.currentTarget;
              const picked = input.files;
              if (!picked || picked.length === 0 || serverLock?.allowUpload === false) {
                input.value = "";
                return;
              }
              void snapshotUploadFiles(picked, (file) => (file as File).arrayBuffer())
                .then((snaps) => {
                  input.value = "";
                  const files = snaps.map(
                    (snap) => new File([snap.bytes], snap.name, { type: snap.type, lastModified: snap.lastModified }),
                  );
                  return handleUpload(files);
                })
                .catch((err) => {
                  input.value = "";
                  toast.error(errMessage(err));
                });
            }}
          />

          {searchHits ? (
            <div className="flex shrink-0 items-center gap-2 border-b border-border bg-bg-elevated px-3 py-2 text-xs text-fg-muted">
              <Search className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                Results for “{query}” in this folder and its subfolders
                {searchTruncated ? " (showing first matches)" : ""}
              </span>
              <Button variant="ghost" size="sm" onClick={clearSearch}>
                Clear
              </Button>
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-auto">
            {loading && !listing ? (
              <div className="grid h-full place-items-center text-fg-subtle">
                <Loader2 className="size-6 animate-spin" />
              </div>
            ) : searching ? (
              <div className="grid h-full place-items-center text-sm text-fg-muted">
                <span className="flex items-center gap-2">
                  <Loader2 className="size-4 animate-spin" />
                  Searching this folder…
                </span>
              </div>
            ) : groupedVisible ? (
              <div className="space-y-4 p-2 md:p-3">
                {groupedVisible.map((group) => (
                  <section key={group.category} className="min-w-0">
                    <h3 className="sticky top-0 z-[1] bg-bg/95 px-1 py-1.5 text-[11px] font-medium tracking-wide text-fg-subtle uppercase backdrop-blur">
                      {CATEGORY_LABEL[group.category]}
                      <span className="ml-2 font-mono text-fg-muted normal-case">
                        {group.items.length}
                      </span>
                    </h3>
                    {view === "list" ? (
                      <FileTable entries={group.items} showFolder={Boolean(searchHits)} {...listProps} />
                    ) : (
                      <FileGrid entries={group.items} {...listProps} />
                    )}
                  </section>
                ))}
                {groupedVisible.length === 0 ? (
                  <div className="grid min-h-48 place-items-center text-sm text-fg-muted">
                    {searchHits ? "No matches" : "This folder is empty"}
                  </div>
                ) : null}
              </div>
            ) : view === "list" ? (
              <FileTable
                entries={visible}
                showFolder={Boolean(searchHits)}
                emptyLabel={searchHits ? "No matches" : undefined}
                {...listProps}
              />
            ) : (
              <FileGrid entries={visible} emptyLabel={searchHits ? "No matches" : undefined} {...listProps} />
            )}
          </div>

          {dragging && (
            <div className="pointer-events-none absolute inset-3 grid place-items-center rounded-lg border border-dashed border-border-strong bg-bg/70 text-sm text-fg">
              Drop files to upload
            </div>
          )}
        </section>

        <aside className="hidden w-80 shrink-0 border-l border-border xl:flex xl:flex-col">
          <PreviewPane
            entry={selectedEntry}
            preview={preview}
            previewUrl={previewUrl}
            busy={busy}
            onDownload={() => void downloadSelected()}
          />
        </aside>
      </div>

      <Sheet open={mobileNav} onOpenChange={setMobileNav}>
        <SheetContent side="left" className="flex flex-col">
          <div className="flex items-center justify-between px-3 py-3">
            <span className="font-mono text-[11px] tracking-[0.16em] text-fg-subtle uppercase">
              Drives
            </span>
            <Button variant="ghost" size="icon-sm" onClick={() => setMobileNav(false)} aria-label="Close">
              <X className="size-4" />
            </Button>
          </div>
          {nav}
          <div className="mt-auto space-y-2 border-t border-border p-3">
            {showAppSettings || showServerSettings ? (
              <Button variant="outline" className="w-full" onClick={openSurfaceSettings}>
                <Settings className="size-3.5" />
                {showAppSettings ? "App settings" : "Settings"}
              </Button>
            ) : null}
            <Button variant="outline" className="w-full" onClick={() => void signOut("/login")}>
              <LogOut className="size-3.5" />
              Lock
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={mobilePreview} onOpenChange={setMobilePreview}>
        <SheetContent side="bottom" className="flex max-h-[80dvh] flex-col xl:hidden">
          <PreviewPane
            entry={selectedEntry}
            preview={preview}
            previewUrl={previewUrl}
            busy={busy}
            onDownload={() => void downloadSelected()}
          />
        </SheetContent>
      </Sheet>

      <DropdownMenu open={Boolean(menuAt)} onOpenChange={(open) => !open && setMenuAt(null)}>
        <DropdownMenuTrigger asChild>
          <span
            aria-hidden
            className="pointer-events-none fixed size-px opacity-0"
            style={{ left: menuAt?.x ?? 0, top: menuAt?.y ?? 0 }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56" data-testid="entry-menu">
          {menuAt ? (
            <>
              <DropdownMenuLabel className="truncate normal-case">
                {menuTargets.length > 1 ? `${menuTargets.length} selected` : menuAt.entry.name}
              </DropdownMenuLabel>
              {menuTargets.length === 1 ? (
                <DropdownMenuItem onSelect={() => void activate(menuAt.entry)}>
                  {menuAt.entry.kind === "dir" ? <FolderOpen /> : <ExternalLink />}
                  Open
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onSelect={() => toggleMark(menuAt.entry)}>
                <CheckSquare />
                {marked.has(menuAt.entry.path) ? "Unselect" : "Select"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!allowMove} onSelect={() => putOnClipboard("cut", menuTargets)}>
                <Scissors />
                Cut
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!allowCopy} onSelect={() => putOnClipboard("copy", menuTargets)}>
                <Copy />
                Copy
              </DropdownMenuItem>
              {menuAt.entry.kind === "dir" && menuTargets.length === 1 ? (
                <DropdownMenuItem
                  disabled={!clip || Boolean(pasteProblem(clip, menuAt.entry.path, pathSep(menuAt.entry.path))) || busy}
                  onSelect={() => void pasteInto(menuAt.entry.path)}
                >
                  <ClipboardPaste />
                  Paste into folder
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem disabled={Boolean(pasteBlocked) || busy} onSelect={() => listing && void pasteInto(listing.path)}>
                <ClipboardPaste />
                Paste here
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {serverLock?.allowRename || serverLock?.allowMove ? (
                <DropdownMenuItem disabled={menuTargets.length !== 1} onSelect={() => askRename(menuAt.entry)}>
                  <Pencil />
                  Rename
                </DropdownMenuItem>
              ) : null}
              {serverLock?.allowDelete ? (
                <DropdownMenuItem danger onSelect={() => askDelete(menuTargets)}>
                  <Trash2 />
                  Delete
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              <SendToSub
                inline={narrow}
                disabled={menuTargets.every((e) => e.kind === "dir")}
                canShare={canShareFiles}
                onShare={() => void sendTo(menuTargets)}
                onDownload={() =>
                  void Promise.all(menuTargets.filter((e) => e.kind !== "dir").map((f) => downloadEntry(f))).catch((err) =>
                    toast.error(errMessage(err)),
                  )
                }
                onCopyPath={() => void copyPaths(menuTargets)}
              />
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={folderOpen} onOpenChange={setFolderOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>Created in the current directory.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="folder-name">Name</Label>
            <Input
              id="folder-name"
              autoFocus
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreateFolder();
              }}
            />
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setFolderOpen(false)}>
              Cancel
            </Button>
            <Button disabled={busy || !folderName.trim()} onClick={() => void handleCreateFolder()}>
              Create
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename</DialogTitle>
            <DialogDescription>Only the name changes — it stays in this folder.</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleRename();
            }}
          />
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <Button disabled={busy || !renameValue.trim()} onClick={() => void handleRename()}>
              Save
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteOpen}
        onOpenChange={(open) => {
          setDeleteOpen(open);
          if (!open) setDeleteTargets([]);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Delete {deleteTargets.length > 1 ? `${deleteTargets.length} items` : (deleteTargets[0] ?? selectedEntry)?.name}?
            </DialogTitle>
            <DialogDescription>
              This cannot be undone
              {(deleteTargets.length ? deleteTargets : selectedEntry ? [selectedEntry] : []).some((e) => e.kind === "dir")
                ? " and removes everything inside."
                : "."}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void handleDelete()}>
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function IconBtn({
  label,
  children,
  onClick,
  disabled,
}: {
  label: string;
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} disabled={disabled} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function DriveNav({
  drives,
  current,
  onOpen,
}: {
  drives: Drive[];
  current: string;
  onOpen: (path: string) => void;
}) {
  const groups: { title: string; items: Drive[] }[] = [
    { title: "This machine", items: drives.filter((d) => d.kind === "volume" || d.kind === "system") },
    { title: "Places", items: drives.filter((d) => d.kind === "home" || d.kind === "project") },
  ].filter((g) => g.items.length > 0);

  return (
    <ScrollArea className="flex-1">
      <div className="space-y-5 p-3">
        {groups.map((group) => (
          <div key={group.title}>
            <p className="mb-1.5 px-2 font-mono text-[10px] tracking-[0.16em] text-fg-subtle uppercase">
              {group.title}
            </p>
            <ul className="space-y-0.5">
              {group.items.map((drive) => {
                const active =
                  current === drive.path ||
                  current.startsWith(drive.path.endsWith("/") || drive.path.endsWith("\\") ? drive.path : `${drive.path}/`) ||
                  current.startsWith(`${drive.path}\\`);
                return (
                  <li key={drive.id}>
                    <button
                      type="button"
                      onClick={() => onOpen(drive.path)}
                      className={cn(
                        "flex h-10 w-full items-center gap-2 rounded-sm px-2 text-left text-sm",
                        active ? "bg-bg-subtle text-fg" : "text-fg-muted hover:bg-bg-subtle hover:text-fg",
                      )}
                    >
                      {drive.kind === "home" ? (
                        <Home className="size-4 shrink-0" strokeWidth={1.7} />
                      ) : drive.kind === "project" ? (
                        <Columns2 className="size-4 shrink-0" strokeWidth={1.7} />
                      ) : (
                        <HardDrive className="size-4 shrink-0" strokeWidth={1.7} />
                      )}
                      <span className="truncate">{drive.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

function MenuBarTrigger({ label }: { label: string }) {
  return (
    <DropdownMenuTrigger asChild>
      <Button
        variant="ghost"
        size="sm"
        className="h-8 shrink-0 gap-1 px-2.5 text-[13px] data-[state=open]:bg-bg-subtle data-[state=open]:text-fg"
      >
        {label}
        <ChevronDown className="size-3.5 opacity-70" />
      </Button>
    </DropdownMenuTrigger>
  );
}

function SendToSub({
  disabled,
  canShare,
  onShare,
  onDownload,
  onCopyPath,
  inline,
}: {
  disabled: boolean;
  canShare: boolean;
  onShare: () => void;
  onDownload: () => void;
  onCopyPath: () => void;
  inline?: boolean;
}) {
  if (inline) {
    // Phones: a side submenu would run off the screen, so the choices sit in the menu itself.
    return (
      <>
        <DropdownMenuLabel className="flex items-center gap-1.5">
          <Send className="size-3" />
          Send to
        </DropdownMenuLabel>
        <DropdownMenuItem disabled={disabled} onSelect={onShare}>
          <Share2 />
          {canShare ? "Share…" : "Share (downloads here)"}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={disabled} onSelect={onDownload}>
          <Download />
          Download to this device
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onCopyPath}>
          <Link2 />
          Copy path
        </DropdownMenuItem>
      </>
    );
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={disabled}>
        <Send />
        Send to
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuItem onSelect={onShare}>
          <Share2 />
          {canShare ? "Share…" : "Share (downloads here)"}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onDownload}>
          <Download />
          Download to this device
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onCopyPath}>
          <Link2 />
          Copy path
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

type EntryListProps = {
  entries: FsEntry[];
  selected: string | null;
  marked: Map<string, FsEntry>;
  clipPaths?: Set<string>;
  entryMenu: EntryMenuApi;
  onClickEntry: (entry: FsEntry, e: React.MouseEvent, openOnTap: boolean) => void;
  onOpen: (entry: FsEntry) => void;
  emptyLabel?: string;
};

const noCallout = { WebkitTouchCallout: "none", WebkitUserSelect: "none", userSelect: "none" } as const;

function FileTable({
  entries,
  selected,
  marked,
  clipPaths,
  entryMenu,
  onClickEntry,
  onOpen,
  showFolder,
  emptyLabel,
}: EntryListProps & { showFolder?: boolean }) {
  if (entries.length === 0) {
    return (
      <div className="grid h-full min-h-48 place-items-center px-6 text-center text-sm text-fg-muted">
        {emptyLabel ?? "This folder is empty"}
      </div>
    );
  }
  return (
    <>
      <ul className="divide-y divide-border md:hidden">
        {entries.map((entry) => {
          const active = selected === entry.path;
          const isMarked = marked.has(entry.path);
          const folder = "folder" in entry && typeof entry.folder === "string" ? entry.folder : "";
          return (
            <li key={entry.path}>
              <button
                type="button"
                {...entryMenu.bind(entry)}
                style={noCallout}
                onClick={(e) => onClickEntry(entry, e, true)}
                className={cn(
                  "flex min-h-14 w-full items-center gap-3 px-3 py-3 text-left",
                  isMarked ? "bg-accent/15" : active ? "bg-bg-subtle" : "active:bg-bg-elevated",
                  clipPaths?.has(entry.path) && "opacity-55",
                )}
              >
                {isMarked ? (
                  <CheckSquare className="size-4 shrink-0 text-fg" />
                ) : (
                  <FileGlyph category={entry.category} className={entry.kind === "dir" ? "text-fg" : "text-fg-muted"} />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{entry.name}</span>
                  <span className="block truncate font-mono text-[11px] text-fg-subtle">
                    {showFolder && folder ? folder : entry.kind === "dir" ? "Folder" : formatBytes(entry.size)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <table className="hidden w-full min-w-[28rem] text-left text-sm md:table">
        <thead className="sticky top-0 bg-bg text-[11px] tracking-wide text-fg-subtle uppercase">
          <tr className="border-b border-border">
            <th className="px-3 py-2 font-medium">Name</th>
            {showFolder ? <th className="px-3 py-2 font-medium">Location</th> : null}
            <th className="w-28 px-3 py-2 font-medium">Size</th>
            <th className="w-48 px-3 py-2 font-medium">Modified</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const active = selected === entry.path;
            const isMarked = marked.has(entry.path);
            const folder = "folder" in entry && typeof entry.folder === "string" ? entry.folder : "";
            return (
              <tr
                key={entry.path}
                {...entryMenu.bind(entry)}
                style={noCallout}
                onClick={(e) => onClickEntry(entry, e, false)}
                onDoubleClick={() => onOpen(entry)}
                className={cn(
                  "cursor-default border-b border-border/70",
                  isMarked ? "bg-accent/15" : active ? "bg-bg-subtle" : "hover:bg-bg-elevated",
                  clipPaths?.has(entry.path) && "opacity-55",
                )}
              >
                <td className="px-3 py-2.5">
                  <span className="flex min-h-10 min-w-0 items-center gap-2">
                    {isMarked ? (
                      <CheckSquare className="size-4 shrink-0 text-fg" />
                    ) : (
                      <FileGlyph category={entry.category} className={entry.kind === "dir" ? "text-fg" : "text-fg-muted"} />
                    )}
                    <span className="truncate">{entry.name}</span>
                  </span>
                </td>
                {showFolder ? (
                  <td className="max-w-[16rem] truncate px-3 py-2.5 font-mono text-[11px] text-fg-muted">
                    {folder}
                  </td>
                ) : null}
                <td className="px-3 py-2.5 font-mono text-xs tabular-nums text-fg-muted">
                  {entry.kind === "dir" ? "—" : formatBytes(entry.size)}
                </td>
                <td className="px-3 py-2.5 text-xs text-fg-muted">{formatWhen(entry.mtime)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

function FileGrid({ entries, selected, marked, clipPaths, entryMenu, onClickEntry, onOpen, emptyLabel }: EntryListProps) {
  if (entries.length === 0) {
    return (
      <div className="grid h-full place-items-center px-6 text-center text-sm text-fg-muted">
        {emptyLabel ?? "This folder is empty"}
      </div>
    );
  }
  return (
    <ul className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 lg:grid-cols-4">
      {entries.map((entry) => {
        const active = selected === entry.path;
        const isMarked = marked.has(entry.path);
        return (
          <li key={entry.path}>
            <button
              type="button"
              {...entryMenu.bind(entry)}
              style={noCallout}
              onClick={(e) => onClickEntry(entry, e, false)}
              onDoubleClick={() => onOpen(entry)}
              className={cn(
                "flex min-h-24 h-full w-full flex-col items-start gap-3 rounded-md border p-3 text-left",
                isMarked
                  ? "border-accent/60 bg-accent/15"
                  : active
                    ? "border-border-strong bg-bg-subtle"
                    : "border-transparent bg-bg-elevated hover:border-border",
                clipPaths?.has(entry.path) && "opacity-55",
              )}
            >
              {isMarked ? (
                <CheckSquare className="size-5 text-fg" />
              ) : (
                <FileGlyph category={entry.category} className={cn("size-5", entry.kind === "dir" ? "text-fg" : "text-fg-muted")} />
              )}
              <span className="line-clamp-2 w-full text-sm leading-snug">{entry.name}</span>
              <span className="font-mono text-[11px] text-fg-subtle">
                {entry.kind === "dir" ? "Folder" : formatBytes(entry.size)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function PreviewPane({
  entry,
  preview,
  previewUrl,
  busy,
  onDownload,
}: {
  entry: FsEntry | null;
  preview: PreviewPayload | null;
  previewUrl: string | null;
  busy: boolean;
  onDownload: () => void;
}) {
  if (!entry) {
    return (
      <div className="grid flex-1 place-items-center px-6 py-10 text-center text-sm text-fg-muted">
        Select a file to inspect it
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border px-4 py-3">
        <p className="truncate text-sm font-medium">{entry.name}</p>
        <p className="mt-1 font-mono text-[11px] text-fg-subtle">
          {entry.kind === "dir" ? "Folder" : formatBytes(entry.size)}
          {entry.ext ? ` · ${entry.ext}` : ""}
        </p>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-4">
          {entry.kind === "dir" ? (
            <p className="text-sm text-fg-muted">Double-click to open this folder.</p>
          ) : preview?.kind === "image" && previewUrl ? (
            <img
              src={previewUrl}
              alt={entry.name}
              className="max-h-72 w-full rounded-sm object-contain outline outline-1 -outline-offset-1 outline-fg/10"
            />
          ) : preview?.kind === "text" ? (
            <pre className="max-h-[28rem] overflow-auto rounded-sm bg-bg p-3 font-mono text-[11px] leading-relaxed text-fg-muted">
              {preview.text}
              {preview.truncated ? "\n\n…truncated" : ""}
            </pre>
          ) : (
            <p className="text-sm text-fg-muted">No inline preview. Download to open it locally.</p>
          )}
        </div>
      </ScrollArea>
      {entry.kind !== "dir" && (
        <div className="border-t border-border p-3">
          <Button className="w-full" disabled={busy} onClick={onDownload}>
            {busy ? <Loader2 className="animate-spin" /> : <Download />}
            Download
          </Button>
        </div>
      )}
    </div>
  );
}
