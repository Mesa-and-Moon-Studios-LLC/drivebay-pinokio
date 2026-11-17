import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { listLinkedBrowse, mutateLinkedBrowse, readLinkedBrowse } from "@/lib/files/linked-machines.functions";

type Entry = { path: string; name: string; directory: boolean; size?: number; modified?: string };

export function LinkedBrowsePanel({
  machineId,
  title,
  onClose,
}: {
  machineId: string;
  title: string;
  onClose: () => void;
}) {
  const [path, setPath] = useState("/");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [folderName, setFolderName] = useState("");

  async function load(next = path) {
    setBusy(true);
    try {
      const listed = await listLinkedBrowse({ data: { machineId, path: next } });
      if (!listed.ok) {
        setNote(listed.message || "Could not browse.");
        setEntries([]);
        return;
      }
      setNote("");
      setPath(listed.path || next);
      setEntries((listed.entries || []) as Entry[]);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineId]);

  const crumbs = ["/", ...path.split("/").filter(Boolean)];

  function crumbPath(index: number) {
    if (index === 0) return "/";
    return "/" + crumbs.slice(1, index + 1).join("/");
  }

  async function openEntry(entry: Entry) {
    if (entry.directory) {
      await load(entry.path);
      return;
    }
    setBusy(true);
    try {
      const file = await readLinkedBrowse({ data: { machineId, path: entry.path } });
      if (!file.ok) {
        toast.error(file.message);
        return;
      }
      const bytes = Uint8Array.from(atob(file.content || ""), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: file.type || "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = file.name || entry.name;
      link.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  }

  async function change(method: "DELETE" | "MKCOL" | "MOVE" | "PUT", target: string, extra: { destination?: string; content?: string } = {}) {
    setBusy(true);
    try {
      const result = await mutateLinkedBrowse({ data: { machineId, method, path: target, ...extra } });
      if (!result.ok) toast.error(result.message);
      else await load(path);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border p-3" data-testid="linked-browse">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-sm text-fg">Browsing {title}</p>
        <Button type="button" size="sm" variant="outline" onClick={() => void load(path)} disabled={busy}>
          Refresh
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="flex flex-wrap gap-1 text-xs">
        {crumbs.map((crumb, index) => (
          <button
            key={`${crumb}-${index}`}
            type="button"
            className="text-fg-muted underline-offset-2 hover:underline"
            onClick={() => void load(crumbPath(index))}
          >
            {index === 0 ? "Storage" : crumb}
            {index < crumbs.length - 1 ? " /" : ""}
          </button>
        ))}
      </div>
      {note ? <p className="text-xs text-fg-muted">{note}</p> : null}
      <div className="divide-y divide-border rounded-md border border-border">
        {path !== "/" ? (
          <button type="button" className="block w-full px-2 py-1 text-left text-sm" onClick={() => void load(crumbPath(crumbs.length - 2))}>
            ..
          </button>
        ) : null}
        {entries.map((entry) => (
          <div key={entry.path} className="flex items-center gap-2 px-2 py-1">
            <button type="button" className="min-w-0 flex-1 truncate text-left text-sm" onClick={() => void openEntry(entry)}>
              {entry.directory ? "📁 " : ""}
              {entry.name}
            </button>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => {
              const next = window.prompt("New name", entry.name);
              if (!next || next === entry.name) return;
              const parent = path === "/" ? "" : path;
              void change("MOVE", entry.path, { destination: `${parent}/${next}` });
            }}>
              Rename
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => {
              if (window.confirm(`Delete ${entry.name}?`)) void change("DELETE", entry.path);
            }}>
              Delete
            </Button>
          </div>
        ))}
        {!busy && entries.length === 0 && !note ? <p className="px-2 py-2 text-xs text-fg-muted">This folder is empty.</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input value={folderName} onChange={(event) => setFolderName(event.target.value)} placeholder="New folder name" className="max-w-xs" />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || !folderName.trim()}
          onClick={() => {
            const next = path === "/" ? `/${folderName.trim()}` : `${path}/${folderName.trim()}`;
            void change("MKCOL", next).then(() => setFolderName(""));
          }}
        >
          New folder
        </Button>
        <label className="text-xs text-fg-muted">
          <span className="sr-only">Upload</span>
          <input
            type="file"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              const reader = new FileReader();
              reader.onload = () => {
                const bytes = new Uint8Array(reader.result as ArrayBuffer);
                let binary = "";
                bytes.forEach((b) => {
                  binary += String.fromCharCode(b);
                });
                const content = btoa(binary);
                const dest = path === "/" ? `/${file.name}` : `${path}/${file.name}`;
                void change("PUT", dest, { content });
              };
              reader.readAsArrayBuffer(file);
            }}
          />
        </label>
      </div>
    </div>
  );
}
