import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowDownAZ,
  ArrowUp,
  ArrowUpDown,
  ChevronRight,
  Clock3,
  Columns2,
  Download,
  Eye,
  EyeOff,
  FolderPlus,
  HardDrive,
  Home,
  LayoutGrid,
  List as ListIcon,
  Loader2,
  LogOut,
  Menu,
  Pencil,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  Upload,
  Layers,
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
  getPreview,
  getSettings,
  listDrives,
  listEntries,
  readFileBase64,
  renameEntry,
  searchFiles,
  uploadFile,
} from "@/lib/files/api.functions";
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewUrlRef = useRef<string | null>(null);
  const [serverLock, setServerLock] = useState<{
    allowDelete: boolean;
    allowRename: boolean;
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
    getSettings()
      .then((s) => {
        if (!alive) return;
        if (s && typeof s === "object" && "serverLock" in s && s.serverLock) {
          const lock = s.serverLock as {
            allowDelete: boolean;
            allowRename: boolean;
            allowCreateFolder: boolean;
            allowUpload: boolean;
            maxUploadMb: number;
          };
          setServerLock({
            allowDelete: lock.allowDelete !== false,
            allowRename: lock.allowRename !== false,
            allowCreateFolder: lock.allowCreateFolder !== false,
            allowUpload: lock.allowUpload !== false,
            maxUploadMb: typeof lock.maxUploadMb === "number" ? lock.maxUploadMb : 512,
          });
        } else {
          setServerLock({
            allowDelete: true,
            allowRename: true,
            allowCreateFolder: true,
            allowUpload: true,
            maxUploadMb: 512,
          });
        }
      })
      .catch(() => {
        if (alive) {
          setServerLock({
            allowDelete: true,
            allowRename: true,
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
  }, [isPending, user, showHidden]);

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
    setBusy(true);
    try {
      // Stream large files via /api/download (no base64 size ceiling).
      const url = `/api/download?path=${encodeURIComponent(selectedEntry.path)}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Download failed (${res.status})`);
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = selectedEntry.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
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
    if (!selectedEntry) return;
    if (serverLock && !serverLock.allowDelete) {
      toast.error("Delete is locked on the server.");
      return;
    }
    setBusy(true);
    try {
      await deleteEntry({ data: { path: selectedEntry.path } });
      setDeleteOpen(false);
      await openPath(listing?.path ?? path);
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === "Backspace" && listing?.parent) {
      e.preventDefault();
      void openPath(listing.parent);
    }
    if (e.key === "Enter" && selectedEntry) {
      e.preventDefault();
      void activate(selectedEntry);
    }
    if ((e.key === "Delete" || e.key === "Backspace") && (e.metaKey || e.ctrlKey) && selectedEntry) {
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

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-bg text-fg" onKeyDown={onKeyDown} tabIndex={0}>
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
        <div className="flex items-center gap-0.5">
          <IconBtn label={showHidden ? "Hide hidden" : "Show hidden"} onClick={() => setShowHidden((v) => !v)}>
            {showHidden ? <Eye /> : <EyeOff />}
          </IconBtn>
          <IconBtn label="List" onClick={() => setView("list")}>
            <ListIcon className={view === "list" ? "text-fg" : undefined} />
          </IconBtn>
          <IconBtn label="Grid" onClick={() => setView("grid")}>
            <LayoutGrid className={view === "grid" ? "text-fg" : undefined} />
          </IconBtn>
          <IconBtn
            label="Sort by name"
            onClick={() => setSortMode("name")}
          >
            <ArrowDownAZ className={sortMode === "name" ? "text-fg" : undefined} />
          </IconBtn>
          <IconBtn label="Sort by type" onClick={() => setSortMode("type")}>
            <ArrowUpDown className={sortMode === "type" ? "text-fg" : undefined} />
          </IconBtn>
          <IconBtn label="Sort by size" onClick={() => setSortMode("size")}>
            <HardDrive className={sortMode === "size" ? "text-fg" : undefined} />
          </IconBtn>
          <IconBtn label="Sort by date" onClick={() => setSortMode("date")}>
            <Clock3 className={sortMode === "date" ? "text-fg" : undefined} />
          </IconBtn>
          <IconBtn
            label={groupByType ? "Ungroup" : "Group by type"}
            onClick={() => setGroupByType((v) => !v)}
          >
            <Layers className={groupByType ? "text-fg" : undefined} />
          </IconBtn>
        </div>
        <div className="hidden items-center gap-2 pl-1 md:flex">
          <span className="max-w-28 truncate text-xs text-fg-muted">{ownerName}</span>
          <Button variant="ghost" size="icon-sm" aria-label="Settings" onClick={() => void navigate({ to: "/settings" })}>
            <Settings className="size-3.5" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void signOut("/login")}>
            <LogOut className="size-3.5" />
            Lock
          </Button>
        </div>
      </header>

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
            if (e.dataTransfer.files.length && serverLock?.allowUpload !== false) {
              void handleUpload(e.dataTransfer.files);
            }
          }}
        >
          <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-1.5">
            <Button
              variant="ghost"
              size="sm"
              disabled={serverLock?.allowCreateFolder === false}
              onClick={() => setFolderOpen(true)}
            >
              <FolderPlus className="size-3.5" />
              New folder
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={serverLock?.allowUpload === false}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="size-3.5" />
              Upload
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) void handleUpload(e.target.files);
                e.target.value = "";
              }}
            />
            <Button
              variant="ghost"
              size="sm"
              disabled={!selectedEntry || serverLock?.allowRename === false}
              onClick={() => {
                if (!selectedEntry) return;
                setRenameValue(selectedEntry.name);
                setRenameOpen(true);
              }}
            >
              <Pencil className="size-3.5" />
              Rename
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!selectedEntry || serverLock?.allowDelete === false}
              className="text-danger hover:text-danger"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="size-3.5" />
              Delete
            </Button>
            <div className="ml-auto hidden text-xs text-fg-subtle sm:block">
              {searching
                ? "Searching…"
                : searchHits
                  ? `${searchHits.length} match${searchHits.length === 1 ? "" : "es"}${searchTruncated ? "+" : ""}`
                  : `${visible.length} ${visible.length === 1 ? "item" : "items"}`}
            </div>
          </div>

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
                      <FileTable
                        entries={group.items}
                        selected={selected}
                        showFolder={Boolean(searchHits)}
                        onSelect={(e) => void inspect(e)}
                        onOpen={(e) => void activate(e)}
                      />
                    ) : (
                      <FileGrid
                        entries={group.items}
                        selected={selected}
                        onSelect={(e) => void inspect(e)}
                        onOpen={(e) => void activate(e)}
                      />
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
                selected={selected}
                showFolder={Boolean(searchHits)}
                emptyLabel={searchHits ? "No matches" : undefined}
                onSelect={(e) => void inspect(e)}
                onOpen={(e) => void activate(e)}
              />
            ) : (
              <FileGrid
                entries={visible}
                selected={selected}
                emptyLabel={searchHits ? "No matches" : undefined}
                onSelect={(e) => void inspect(e)}
                onOpen={(e) => void activate(e)}
              />
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
            <Button
              variant="outline"
              className="w-full"
              onClick={() => {
                setMobileNav(false);
                void navigate({ to: "/settings" });
              }}
            >
              <Settings className="size-3.5" />
              Settings
            </Button>
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

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {selectedEntry?.name}?</DialogTitle>
            <DialogDescription>
              This cannot be undone
              {selectedEntry?.kind === "dir" ? " and removes everything inside." : "."}
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

function FileTable({
  entries,
  selected,
  onSelect,
  onOpen,
  showFolder,
  emptyLabel,
}: {
  entries: FsEntry[];
  selected: string | null;
  onSelect: (entry: FsEntry) => void;
  onOpen: (entry: FsEntry) => void;
  showFolder?: boolean;
  emptyLabel?: string;
}) {
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
          const folder = "folder" in entry && typeof entry.folder === "string" ? entry.folder : "";
          return (
            <li key={entry.path}>
              <button
                type="button"
                onClick={() => onOpen(entry)}
                className={cn(
                  "flex min-h-14 w-full items-center gap-3 px-3 py-3 text-left",
                  active ? "bg-bg-subtle" : "active:bg-bg-elevated",
                )}
              >
                <FileGlyph
                  category={entry.category}
                  className={entry.kind === "dir" ? "text-fg" : "text-fg-muted"}
                />
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
            const folder = "folder" in entry && typeof entry.folder === "string" ? entry.folder : "";
            return (
              <tr
                key={entry.path}
                onClick={() => onSelect(entry)}
                onDoubleClick={() => onOpen(entry)}
                className={cn(
                  "cursor-default border-b border-border/70",
                  active ? "bg-bg-subtle" : "hover:bg-bg-elevated",
                )}
              >
                <td className="px-3 py-2.5">
                  <span className="flex min-h-10 min-w-0 items-center gap-2">
                    <FileGlyph
                      category={entry.category}
                      className={entry.kind === "dir" ? "text-fg" : "text-fg-muted"}
                    />
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

function FileGrid({
  entries,
  selected,
  onSelect,
  onOpen,
  emptyLabel,
}: {
  entries: FsEntry[];
  selected: string | null;
  onSelect: (entry: FsEntry) => void;
  onOpen: (entry: FsEntry) => void;
  emptyLabel?: string;
}) {
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
        return (
          <li key={entry.path}>
            <button
              type="button"
              onClick={() => onSelect(entry)}
              onDoubleClick={() => onOpen(entry)}
              className={cn(
                "flex min-h-24 h-full w-full flex-col items-start gap-3 rounded-md border p-3 text-left",
                active ? "border-border-strong bg-bg-subtle" : "border-transparent bg-bg-elevated hover:border-border",
              )}
            >
              <FileGlyph
                category={entry.category}
                className={cn("size-5", entry.kind === "dir" ? "text-fg" : "text-fg-muted")}
              />
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
