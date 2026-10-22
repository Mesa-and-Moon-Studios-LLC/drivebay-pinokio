import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  approveLinkedRequest,
  connectLinkedMachine,
  createLinkedCode,
  disconnectLinkedMachine,
  finishLinkedMachine,
  getLinkedStatus,
  listLinkedMachines,
  saveLinkedShares,
  saveMesaSession,
  signOutMesa,
} from "@/lib/files/linked-machines.functions";
import { appleAuthorizeUrl, googleAuthorizeUrl, idpPostBody, readIdTokenFragment } from "@/lib/files/mesa-signin.mjs";

type ShareRow = { path: string; access: "ro" | "rw"; name?: string };
type MachineRow = {
  machineId: string;
  displayName: string;
  type: string;
  online: boolean;
  self: boolean;
  hidden?: boolean;
  connect?: { via?: string; risk?: boolean; url?: string };
};

type Status = {
  account: { signedIn: boolean; email: string; displayName: string };
  config: {
    ready: boolean;
    google: boolean;
    apple: boolean;
    apiKey?: string;
    googleClientId?: string;
    appleClientId?: string;
  };
  shares: { hidden: boolean; directInternet: boolean; publicHost: string; folders: ShareRow[] };
  pairs: { pending: { id: string; name: string }[] };
  links: { machineId: string; label: string; paired: boolean; via: string }[];
  self: { displayName: string } | null;
  warning: string;
};

export function LinkedMachines() {
  const [status, setStatus] = useState<Status | null>(null);
  const [machines, setMachines] = useState<MachineRow[]>([]);
  const [listNote, setListNote] = useState("");
  const [name, setName] = useState("");
  const [hidden, setHidden] = useState(false);
  const [direct, setDirect] = useState(false);
  const [publicHost, setPublicHost] = useState("");
  const [folders, setFolders] = useState<ShareRow[]>([]);
  const [folderPath, setFolderPath] = useState("");
  const [folderAccess, setFolderAccess] = useState<"ro" | "rw">("ro");
  const [code, setCode] = useState("");
  const [pairCode, setPairCode] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const next = await getLinkedStatus();
    setStatus(next as Status);
    setName(next.self?.displayName || "");
    setHidden(next.shares.hidden === true);
    setDirect(next.shares.directInternet === true);
    setPublicHost(next.shares.publicHost || "");
    setFolders(next.shares.folders || []);
    if (next.account.signedIn) {
      const listed = await listLinkedMachines();
      if (listed.ok) {
        setMachines(listed.machines as MachineRow[]);
        setListNote("");
      } else {
        setMachines([]);
        setListNote(listed.message);
      }
    } else {
      setMachines([]);
    }
  }

  useEffect(() => {
    void refresh().catch(() => {});
    const parsed = readIdTokenFragment(window.location.hash);
    if (parsed && window.opener) {
      window.opener.postMessage({ type: "mesa-id-token", ...parsed }, window.location.origin);
      window.close();
    }
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string; idToken?: string; provider?: string; nonce?: string };
      if (data?.type !== "mesa-id-token" || !data.idToken || !data.provider) return;
      const expected = sessionStorage.getItem("mesa-nonce");
      if (!expected || data.nonce !== expected) return;
      sessionStorage.removeItem("mesa-nonce");
      void completeSignIn(data.provider === "apple" ? "apple.com" : "google.com", data.idToken);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // The sign-in popup lands on this page once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function completeSignIn(providerId: string, idToken: string) {
    if (!status?.config.apiKey) {
      toast.error("Mesa and Moon sign-in is not configured on this machine.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${encodeURIComponent(status.config.apiKey)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            postBody: idpPostBody(providerId, idToken),
            requestUri: window.location.origin,
            returnSecureToken: true,
            returnIdpCredential: true,
          }),
        },
      );
      const body = await res.json();
      if (!res.ok || !body.idToken || !body.refreshToken) {
        toast.error("Mesa and Moon did not accept that sign-in.");
        return;
      }
      const saved = await saveMesaSession({
        data: {
          idToken: String(body.idToken),
          refreshToken: String(body.refreshToken),
          expiresIn: Number(body.expiresIn) || 3600,
        },
      });
      if (!saved.ok) toast.error(saved.message);
      else toast.success("Signed in to Mesa and Moon");
      await refresh();
    } catch {
      toast.error("Mesa and Moon did not accept that sign-in.");
    } finally {
      setBusy(false);
    }
  }

  function startProvider(provider: "google" | "apple") {
    if (!status?.config.ready) {
      toast.error("Add mesa-firebase.json on this machine. Drivebay keeps working without it.");
      return;
    }
    const clientId = provider === "google" ? status.config.googleClientId : status.config.appleClientId;
    if (!clientId) {
      toast.error(provider === "google" ? "Google sign-in is not configured." : "Apple sign-in is not configured.");
      return;
    }
    const nonce = crypto.randomUUID();
    sessionStorage.setItem("mesa-nonce", nonce);
    const redirectUri = `${window.location.origin}/settings`;
    const url =
      provider === "google"
        ? googleAuthorizeUrl({ clientId, redirectUri, nonce })
        : appleAuthorizeUrl({ clientId, redirectUri, nonce });
    window.open(url, "mesa-sign-in", "width=480,height=720");
  }

  async function saveShareForm() {
    setBusy(true);
    try {
      const saved = await saveLinkedShares({
        data: { displayName: name.trim(), hidden, directInternet: direct, publicHost: publicHost.trim(), folders },
      });
      if (!saved.ok) toast.error(saved.message);
      else {
        toast.success("Saved");
        await refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  async function showCode() {
    setBusy(true);
    try {
      const issued = await createLinkedCode();
      setPairCode(issued.code);
      toast.success("Code ready");
    } finally {
      setBusy(false);
    }
  }

  async function connect(machine: MachineRow, acceptRisk = false) {
    setBusy(true);
    try {
      const result = await connectLinkedMachine({
        data: { machineId: machine.machineId, code: code.trim(), letter: "P", acceptRisk },
      });
      if ("needsRisk" in result && result.needsRisk) {
        toast.error(result.message);
        return;
      }
      if ("pending" in result && result.pending) {
        toast.success(result.message);
        return;
      }
      if (result.ok) toast.success(`Mounted ${machine.displayName}`);
      else toast.error(result.message);
      setCode("");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function finish(machineId: string) {
    const result = await finishLinkedMachine({ data: { machineId } });
    if (result.ok && !("pending" in result && result.pending)) toast.success("Mounted");
    else if (!result.ok) toast.message(result.message);
    await refresh();
  }

  const signedIn = status?.account.signedIn === true;

  return (
    <section className="space-y-3">
      <p className="font-mono text-[10px] tracking-[0.16em] text-fg-subtle uppercase">Mesa and Moon</p>
      <div className="space-y-4 rounded-md border border-border bg-bg-elevated p-4 text-sm">
        <div>
          <p className="text-base font-medium text-fg">Mesa and Moon</p>
          <p className="mt-1 text-xs text-fg-muted">
            Optional. Drivebay works without an account. Your files never touch our servers. The account stores only
            how to reach this machine: its name, type, Tailscale or LAN address, port, public key, and last seen.
          </p>
        </div>
        {signedIn ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-fg">{status?.account.email || status?.account.displayName}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                void signOutMesa().then(() => refresh());
              }}
            >
              Sign out
            </Button>
          </div>
        ) : (
          <div className="mx-auto flex max-w-sm flex-col gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => startProvider("google")}
              className="rounded-md bg-white px-4 py-2.5 text-sm font-medium text-neutral-900"
            >
              Continue with Google
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => startProvider("apple")}
              className="rounded-md bg-black px-4 py-2.5 text-sm font-medium text-white"
            >
              Continue with Apple
            </button>
            {status && !status.config.ready ? (
              <p className="text-xs text-fg-muted">
                Sign-in needs mesa-firebase.json on this machine. Until then these buttons explain what is missing, and
                Drivebay stays fully usable.
              </p>
            ) : null}
          </div>
        )}

        <div className="space-y-1">
          <Label htmlFor="machine-name">Name on this login</Label>
          <Input id="machine-name" value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={hidden} onChange={(event) => setHidden(event.target.checked)} />
          Hidden. Other machines on this login do not see this one.
        </label>

        <div className="space-y-2">
          <p className="font-mono text-[10px] tracking-[0.16em] text-fg-subtle uppercase">Shared folders</p>
          <p className="text-xs text-fg-muted">Nothing is shared until you add a folder. WebDAV exposes only this list.</p>
          {folders.length === 0 ? <p className="text-xs text-fg-muted">No folders shared.</p> : null}
          {folders.map((folder) => (
            <div key={folder.path} className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{folder.path}</span>
              <select
                className="rounded-md border border-border bg-bg px-2 py-1 text-xs"
                value={folder.access}
                onChange={(event) =>
                  setFolders((prev) =>
                    prev.map((row) =>
                      row.path === folder.path ? { ...row, access: event.target.value === "rw" ? "rw" : "ro" } : row,
                    ),
                  )
                }
              >
                <option value="ro">Read-only</option>
                <option value="rw">Read-write</option>
              </select>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setFolders((prev) => prev.filter((row) => row.path !== folder.path))}
              >
                Remove
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Input
              value={folderPath}
              placeholder="C:\Users\me\Shared or /home/me/Shared"
              onChange={(event) => setFolderPath(event.target.value)}
            />
            <select
              className="rounded-md border border-border bg-bg px-2 py-1 text-xs"
              value={folderAccess}
              onChange={(event) => setFolderAccess(event.target.value === "rw" ? "rw" : "ro")}
            >
              <option value="ro">Read-only</option>
              <option value="rw">Read-write</option>
            </select>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const next = folderPath.trim();
                if (!next) return;
                setFolders((prev) => [...prev.filter((row) => row.path !== next), { path: next, access: folderAccess }]);
                setFolderPath("");
              }}
            >
              Add folder
            </Button>
          </div>
        </div>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={direct}
            onChange={(event) => setDirect(event.target.checked)}
          />
          <span>
            I opened this port on the public internet myself. {status?.warning}
          </span>
        </label>
        {direct ? (
          <div className="space-y-1">
            <Label htmlFor="public-host">Public address</Label>
            <Input
              id="public-host"
              value={publicHost}
              placeholder="203.0.113.10 or home.example.com"
              onChange={(event) => setPublicHost(event.target.value)}
            />
          </div>
        ) : null}
        <Button type="button" size="sm" disabled={busy} onClick={() => void saveShareForm()}>
          Save machine
        </Button>

        <div className="space-y-2">
          <p className="font-mono text-[10px] tracking-[0.16em] text-fg-subtle uppercase">Pairing</p>
          <p className="text-xs text-fg-muted">
            The account can list machines. Opening one still needs a code or an approval on that machine. A stolen
            login cannot mount a drive by itself.
          </p>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void showCode()}>
            Show a 6-digit code
          </Button>
          {pairCode ? <p className="font-mono text-lg tracking-widest text-fg">{pairCode}</p> : null}
          {(status?.pairs.pending || []).map((row) => (
            <div key={row.id} className="flex items-center gap-2">
              <span className="text-xs">{row.name || "A machine"} wants to connect.</span>
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  void approveLinkedRequest({ data: { id: row.id } }).then(() => refresh());
                }}
              >
                Approve
              </Button>
            </div>
          ))}
        </div>

        <div className="space-y-2">
          <p className="font-mono text-[10px] tracking-[0.16em] text-fg-subtle uppercase">My machines</p>
          {listNote ? <p className="text-xs text-fg-muted">{listNote}</p> : null}
          {!signedIn ? <p className="text-xs text-fg-muted">Sign in to see the other machines on this login.</p> : null}
          {signedIn && machines.length === 0 && !listNote ? (
            <p className="text-xs text-fg-muted">No other machines yet. Sign in on each one.</p>
          ) : null}
          <div className="space-y-1">
            <Label htmlFor="pair-code">Code from the other machine</Label>
            <Input id="pair-code" value={code} onChange={(event) => setCode(event.target.value)} />
          </div>
          {machines.map((machine) => (
            <div key={machine.machineId} className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm text-fg">
                  {machine.displayName}{" "}
                  <span className="text-xs text-fg-muted">
                    {machine.type}
                    {machine.self ? " · this machine" : ""}
                    {machine.hidden ? " · hidden" : ""}
                    {machine.online ? " · online" : " · offline"}
                    {machine.connect?.via ? ` · ${machine.connect.via}` : ""}
                  </span>
                </p>
              </div>
              {machine.self ? null : (
                <>
                  <Button type="button" size="sm" disabled={busy} onClick={() => void connect(machine, false)}>
                    Connect
                  </Button>
                  {machine.connect?.risk ? (
                    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void connect(machine, true)}>
                      Connect over the public internet
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void connectLinkedMachine({
                          data: { machineId: machine.machineId, askApproval: true, letter: "P" },
                        }).then((result) => {
                          if (result.ok) toast.success(result.message);
                          else toast.error(result.message);
                        })
                      }
                    >
                      Ask to approve
                    </Button>
                  )}
                  <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void finish(machine.machineId)}>
                    Check approval
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void disconnectLinkedMachine({ data: { machineId: machine.machineId, forget: true } }).then(() => refresh())
                    }
                  >
                    Forget
                  </Button>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
