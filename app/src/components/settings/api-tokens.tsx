import { useEffect, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { allowApiWrite, createApiToken, getApiAccess, revokeApiToken } from "@/lib/files/api.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type TokenRow = {
  id: string;
  name: string;
  prefix: string;
  roots?: string[];
  expiresAt: number | null;
  lastUsedAt: number | null;
  writeUntil: number | null;
  expired: boolean;
};

type AuditRow = {
  at: number;
  tokenName: string;
  action: string;
  path: string;
  status: number;
  detail: string;
};

type Panel = {
  canManage: boolean;
  canWriteWindow: boolean;
  tokens: TokenRow[];
  audit: AuditRow[];
};

function when(value: number | null): string {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

export function ApiTokens() {
  const [panel, setPanel] = useState<Panel | null>(null);
  const [name, setName] = useState("");
  const [roots, setRoots] = useState("");
  const [days, setDays] = useState<0 | 7 | 30 | 90>(0);
  const [minutes, setMinutes] = useState<Record<string, 15 | 60 | 240>>({});
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const next = await getApiAccess();
    setPanel(next);
  }

  useEffect(() => {
    let alive = true;
    getApiAccess()
      .then((next) => {
        if (alive) setPanel(next);
      })
      .catch(() => {
        if (alive) setPanel({ canManage: false, canWriteWindow: false, tokens: [], audit: [] });
      });
    const timer = window.setInterval(() => {
      getApiAccess()
        .then((next) => {
          if (alive) setPanel(next);
        })
        .catch(() => undefined);
    }, 4000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const created = await createApiToken({
        data: {
          name,
          roots: roots
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean),
          days,
        },
      });
      setSecret(created.token);
      setName("");
      setRoots("");
      toast.success("Token created. Copy it now.");
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create the token");
    } finally {
      setBusy(false);
    }
  }

  async function onAllow(id: string) {
    setBusy(true);
    try {
      await allowApiWrite({ data: { id, minutes: minutes[id] ?? 15 } });
      toast.success("Write window opened");
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not allow writes");
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke(id: string) {
    setBusy(true);
    try {
      await revokeApiToken({ data: { id } });
      toast.success("Token revoked");
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not revoke the token");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3">
      <p className="font-mono text-[10px] tracking-[0.16em] text-fg-subtle uppercase">API tokens</p>
      <div className="space-y-4 rounded-md border border-border bg-bg-elevated p-4 text-xs text-fg-muted">
        <p>
          A token is a key for the folders it is allowed to read. Drivebay shows the secret once, then stores only a hash.
          Clients send <span className="font-mono text-fg">Authorization: Bearer</span>. Reads cover roots, list, stat,
          search, download with Range, and thumbnails. Writes stay off until you allow a window, and they still follow
          the server lock on this PC.
        </p>
        {panel == null ? <p>Loading tokens…</p> : null}
        {panel && !panel.canManage && !panel.canWriteWindow ? (
          <p>API tokens are created on this PC. A signed-in Tailscale device can open a write window for a token.</p>
        ) : null}
        {secret ? (
          <div className="space-y-2">
            <p className="text-fg">Copy this token now. It cannot be shown again.</p>
            <Input readOnly value={secret} aria-label="New API token" />
          </div>
        ) : null}
        {panel?.canManage ? (
          <form className="space-y-3" onSubmit={(event) => void onCreate(event)}>
            <div>
              <Label htmlFor="token-name">Name</Label>
              <Input id="token-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required />
            </div>
            <div>
              <Label htmlFor="token-roots">Folders</Label>
              <textarea
                id="token-roots"
                value={roots}
                onChange={(event) => setRoots(event.target.value)}
                placeholder="One folder per line. Empty means every drive this PC already allows."
                className="mt-1.5 block min-h-20 w-full rounded-sm border border-border bg-bg px-3 py-2 text-sm text-fg"
              />
            </div>
            <div>
              <Label htmlFor="token-days">Expires</Label>
              <select
                id="token-days"
                className="mt-1.5 block w-full rounded-sm border border-border bg-bg px-3 py-2 text-sm text-fg"
                value={days}
                onChange={(event) => setDays(Number(event.target.value) as 0 | 7 | 30 | 90)}
              >
                <option value={0}>Never</option>
                <option value={7}>7 days</option>
                <option value={30}>30 days</option>
                <option value={90}>90 days</option>
              </select>
            </div>
            <Button type="submit" disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              Create token
            </Button>
          </form>
        ) : null}
        {panel && (panel.canManage || panel.canWriteWindow)
          ? panel.tokens.map((token) => (
              <div key={token.id} className="space-y-1 rounded-sm border border-border px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm text-fg">
                    {token.name} <span className="font-mono text-fg-muted">{token.prefix}</span>
                  </p>
                  {panel.canManage ? (
                    <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void onRevoke(token.id)}>
                      Revoke
                    </Button>
                  ) : null}
                </div>
                <p>
                  Expires {token.expiresAt ? when(token.expiresAt) : "never"}
                  {token.expired ? " (expired)" : ""}. Last used {when(token.lastUsedAt)}. Write until {when(token.writeUntil)}.
                </p>
                {panel.canWriteWindow ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      aria-label={`Allow write for ${token.name}`}
                      className="rounded-sm border border-border bg-bg px-2 py-1 text-sm text-fg"
                      value={minutes[token.id] ?? 15}
                      onChange={(event) =>
                        setMinutes((current) => ({ ...current, [token.id]: Number(event.target.value) as 15 | 60 | 240 }))
                      }
                    >
                      <option value={15}>15 min</option>
                      <option value={60}>1 h</option>
                      <option value={240}>4 h</option>
                    </select>
                    <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void onAllow(token.id)}>
                      Allow write for
                    </Button>
                  </div>
                ) : null}
                {panel.canManage ? (
                  token.roots && token.roots.length ? (
                    <p className="font-mono break-all">{token.roots.join("\n")}</p>
                  ) : (
                    <p>Every drive this PC already allows.</p>
                  )
                ) : null}
              </div>
            ))
          : null}
        {panel?.canManage ? (
          <div className="space-y-2">
            <p className="text-fg">Audit log</p>
            {panel.audit.length === 0 ? <p>No token calls yet.</p> : null}
            {panel.audit.map((entry, index) => (
              <p key={`${entry.at}-${index}`} className="font-mono break-all">
                {when(entry.at)} {entry.tokenName} {entry.action} {entry.status} {entry.path}
              </p>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
