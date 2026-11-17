import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { activateEdition, deactivateEdition, getEditionStatus, refreshEdition } from "@/lib/license/license.functions";

type EditionView = Awaited<ReturnType<typeof getEditionStatus>>;

function day(ts: number | null | undefined) {
  return ts ? new Date(ts * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
}

const FREE_LINES = [
  "Link all your own machines, over Tailscale or your local network",
  "Mount them as drives and use the phone as a drive",
  "Share up to 3 folders with other people",
];
const PRO_LINES = [
  "Remote access from a trusted device, read-only or read-and-write, with a timer",
  "Public access over a port you forwarded yourself",
  "More shared folders, and more devices on one license",
];

/** Settings → Edition: current edition, enter a purchase code, deactivate this machine. */
export function EditionCard() {
  const [view, setView] = useState<EditionView | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    try {
      setView(await getEditionStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read the edition.");
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function onActivate() {
    setBusy(true);
    setError("");
    try {
      const { result, status } = await activateEdition({ data: { code } });
      setView(status);
      if (result.ok) {
        setCode("");
        toast.success(result.offline ? "License file accepted." : "Activated.");
      } else {
        const devices = (result as { devices?: { name?: string }[] }).devices;
        setError(
          devices?.length
            ? `${result.error} In use on: ${devices.map((d) => d.name || "a device").join(", ")}.`
            : result.error,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not activate.");
    } finally {
      setBusy(false);
    }
  }

  async function onRefresh() {
    setBusy(true);
    setError("");
    try {
      const { result, status } = await refreshEdition();
      setView(status);
      if (result.ok) toast.success("License refreshed.");
      else setError(result.error || "Could not refresh.");
    } finally {
      setBusy(false);
    }
  }

  async function onDeactivate(force: boolean) {
    setBusy(true);
    setError("");
    try {
      const { result, status } = await deactivateEdition({ data: { force } });
      setView(status);
      if (result.ok) {
        toast.success(result.released ? "This machine was deactivated and the seat is free." : "License removed from this machine.");
      } else {
        setError(`${result.error} You can remove it from this machine anyway; the seat then frees up on its own later.`);
      }
    } finally {
      setBusy(false);
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 20_000) {
      setError("That file is too large to be a Drivebay license.");
      return;
    }
    setCode(await file.text());
  }

  if (!view) return <p className="text-sm text-fg-muted">{error || "Checking your edition…"}</p>;
  const paid = view.edition !== "free";
  return (
    <div className="space-y-4" data-testid="edition-card">
      <div className="space-y-2 rounded-md border border-border bg-bg-elevated p-4 text-sm">
        <p className="text-fg">
          Edition: <span className="font-medium">{view.name}</span>
          {view.label ? <span className="text-fg-muted"> · {view.label}</span> : null}
        </p>
        {paid ? (
          <ul className="space-y-1 text-xs text-fg-muted">
            <li>{view.seats} {view.seats === 1 ? "device" : "devices"} on this license</li>
            <li>{view.expires ? `Renews or ends ${day(view.expires)}` : "Does not expire"}</li>
            <li>{view.updatesUntil ? `Updates included until ${day(view.updatesUntil)}` : "Updates included for life"}</li>
            {view.offline ? <li>Offline license file (no check-in needed)</li> : null}
            {view.keyHint ? <li className="font-mono">{view.keyHint}</li> : null}
          </ul>
        ) : (
          <ul className="list-disc space-y-1 pl-5 text-xs text-fg-muted">
            {FREE_LINES.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
        {view.detail ? <p className="text-xs text-amber-500" role="status">{view.detail}</p> : null}
      </div>

      {!paid || view.status !== "active" ? (
        <div className="space-y-2 rounded-md border border-border p-4">
          <p className="text-xs text-fg-muted">Pro and Elite add:</p>
          <ul className="list-disc space-y-1 pl-5 text-xs text-fg-muted">
            {PRO_LINES.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <a className="inline-block text-xs underline underline-offset-4" href={view.upgradeUrl} target="_blank" rel="noreferrer noopener">
            See the editions
          </a>
        </div>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="edition-code">{paid ? "Use a different code or license file" : "Purchase code or license"}</Label>
        <Input
          id="edition-code"
          value={code}
          placeholder="DBAY-XXXX-XXXX-XXXX-XXXX"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setCode(event.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" disabled={busy || code.trim().length < 8} onClick={() => void onActivate()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Activate
          </Button>
          <label className="cursor-pointer text-xs underline underline-offset-4">
            Choose a license file
            <input type="file" accept=".dbaylicense,.txt" className="sr-only" onChange={(event) => void onFile(event.target.files?.[0])} />
          </label>
        </div>
        {error ? <p className="text-xs text-red-500" role="alert">{error}</p> : null}
      </div>

      {view.keyHint ? (
        <div className="flex flex-wrap gap-2">
          {!view.offline ? (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void onRefresh()}>
              Refresh
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void onDeactivate(false)}>
            Deactivate this machine
          </Button>
          {error && !busy ? (
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void onDeactivate(true)}>
              Remove anyway
            </Button>
          ) : null}
        </div>
      ) : null}
      <p className="text-xs text-fg-muted">
        Activation sends the code, a random machine id and this machine's name to Mesa and Moon so seats can be counted. It never sends file names or contents.
      </p>
    </div>
  );
}
