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
  setMachineRemoteAccess,
  signOutMesa,
} from "@/lib/files/linked-machines.functions";
import { VaultLock } from "@/components/settings/vault-lock";
import { RemoteAccessBanner } from "@/components/remote-access-banner";
import {
  bridgeStartUrl,
  cleanEmail,
  emailAuthBody,
  emailAuthError,
  emailAuthUrl,
  emailSession,
  passwordOk,
  providerConflictMessage,
  readSessionFragment,
  signinBridgeUrl,
} from "@/lib/files/mesa-signin.mjs";

const NONCE_KEY = "mesa-nonce";
const SIGNED_IN_KEY = "mesa-signed-in-at";

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
    email?: boolean;
    apiKey?: string;
    googleClientId?: string;
    appleClientId?: string;
    authEmulator?: string;
    authDomain?: string;
    signinBridge?: string;
  };
  shares: { hidden: boolean; directInternet: boolean; publicHost: string; folders: ShareRow[] };
  pairs: { pending: { id: string; name: string }[] };
  links: { machineId: string; label: string; paired: boolean; via: string }[];
  self: { displayName: string } | null;
  warning: string;
  vault?: { ready?: boolean; unlocked?: boolean; hasPassphrase?: boolean; hasPasskey?: boolean; hasRecovery?: boolean; cannotRecover?: string };
  remoteAccess?: { enabled?: boolean; offAt?: number | null; mode?: string; source?: string; byName?: string };
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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [remoteMinutes, setRemoteMinutes] = useState(15);
  const [remoteMode, setRemoteMode] = useState<"ro" | "rw">("ro");

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
    // Google and Apple come back through the sign-in page on the Firebase domain,
    // which lands here with the session in the fragment.
    const parsed = readSessionFragment(window.location.hash);
    if (parsed) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      const expected = window.localStorage.getItem(NONCE_KEY);
      window.localStorage.removeItem(NONCE_KEY);
      if (!expected || parsed.state !== expected) {
        toast.error("That Mesa and Moon sign-in did not start on this machine.");
      } else {
        void finishProviderSignIn(parsed);
      }
    }
    void refresh().catch(() => {});
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      if ((event.data as { type?: string })?.type !== "mesa-signed-in") return;
      void refresh().catch(() => {});
    }
    function onStorage(event: StorageEvent) {
      if (event.key === SIGNED_IN_KEY) void refresh().catch(() => {});
    }
    window.addEventListener("message", onMessage);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("storage", onStorage);
    };
    // The sign-in window lands on this page once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function finishProviderSignIn(session: { idToken: string; refreshToken: string; expiresIn: number }) {
    setBusy(true);
    try {
      const saved = await saveMesaSession({
        data: { idToken: session.idToken, refreshToken: session.refreshToken, expiresIn: session.expiresIn },
      });
      if (!saved.ok) {
        toast.error(saved.message);
        return;
      }
      toast.success("Signed in to Mesa and Moon");
      window.localStorage.setItem(SIGNED_IN_KEY, String(Date.now()));
      if (window.opener && !window.opener.closed) {
        try {
          window.opener.postMessage({ type: "mesa-signed-in" }, window.location.origin);
          window.close();
          return;
        } catch {
          // The sign-in window lost its opener. Stay here, signed in.
        }
      }
      await refresh();
    } catch {
      toast.error("Mesa and Moon did not accept that sign-in.");
    } finally {
      setBusy(false);
    }
  }

  async function submitEmail(action: "signIn" | "signUp" | "reset") {
    if (!status?.config.ready || !status.config.apiKey) {
      toast.error("Add mesa-firebase.json on this machine. Drivebay keeps working without it.");
      return;
    }
    const address = cleanEmail(email);
    if (!address.includes("@")) {
      toast.error("Enter the email for this Mesa and Moon account.");
      return;
    }
    if (action !== "reset" && !passwordOk(password)) {
      toast.error("Use a password of at least 8 characters.");
      setPassword("");
      return;
    }
    setBusy(true);
    const typed = password;
    setPassword("");
    try {
      const res = await fetch(emailAuthUrl(status.config, action), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(emailAuthBody(action, { email: address, password: typed, continueUri: window.location.origin })),
      });
      const body = await res.json().catch(() => ({}));
      if (action === "reset") {
        toast.success(emailAuthError("reset", body).message);
        return;
      }
      if (!res.ok) {
        if (action === "signUp" && String(body?.error?.message || "").includes("EMAIL_EXISTS")) {
          const lookup = await fetch(emailAuthUrl(status.config, "lookup"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(emailAuthBody("lookup", { email: address, continueUri: window.location.origin })),
          });
          const info = await lookup.json().catch(() => ({}));
          const methods = info.signinMethods || info.allProviders || [];
          toast.error(providerConflictMessage(methods));
          return;
        }
        toast.error(emailAuthError(action, body).message);
        return;
      }
      const session = emailSession(body);
      if (!session) {
        toast.error("Mesa and Moon did not accept that sign-in.");
        return;
      }
      const saved = await saveMesaSession({
        data: { idToken: session.idToken, refreshToken: session.refreshToken, expiresIn: session.expiresIn },
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
    const enabled = provider === "google" ? status.config.google : status.config.apple;
    const bridge = signinBridgeUrl(status.config);
    if (!enabled || !bridge) {
      toast.error(provider === "google" ? "Google sign-in is not configured." : "Apple sign-in is not configured.");
      return;
    }
    const nonce = crypto.randomUUID();
    // localStorage, so the sign-in window and this tab both see it.
    window.localStorage.setItem(NONCE_KEY, nonce);
    const url = bridgeStartUrl({ bridge, provider, state: nonce, returnTo: `${window.location.origin}/settings` });
    const popup = window.open(url, "mesa-sign-in", "width=480,height=720");
    if (!popup) window.location.assign(url);
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
        data: { machineId: machine.machineId, code: code.trim(), acceptRisk },
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
            <form
              className="space-y-2 rounded-md border border-border p-3"
              onSubmit={(event) => {
                event.preventDefault();
                void submitEmail("signIn");
              }}
            >
              <p className="text-sm font-medium text-fg">Email</p>
              <Input
                type="email"
                autoComplete="username"
                value={email}
                placeholder="you@example.com"
                onChange={(event) => setEmail(event.target.value)}
              />
              <Input
                type="password"
                autoComplete="current-password"
                value={password}
                placeholder="Password"
                onChange={(event) => setPassword(event.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" size="sm" disabled={busy}>
                  Sign in
                </Button>
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void submitEmail("signUp")}>
                  Create account
                </Button>
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void submitEmail("reset")}>
                  Email me a reset link
                </Button>
              </div>
              <p className="text-xs text-fg-muted">
                The password is sent to Mesa and Moon sign-in and is not saved on this machine. If this email already
                belongs to Google or Apple, use that button. It stays one account.
              </p>
            </form>
            {status && !status.config.ready ? (
              <p className="text-xs text-fg-muted">
                Sign-in needs mesa-firebase.json on this machine. Until then these buttons explain what is missing, and
                Drivebay stays fully usable.
              </p>
            ) : null}
          </div>
        )}

        <VaultLock vault={status?.vault} config={status?.config} signedIn={signedIn} onDone={() => void refresh()} />
        <RemoteAccessBanner access={status?.remoteAccess} machineId="self" onChange={() => void refresh()} />

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
                  {machine.connect?.via === "tailscale" ? (
                    <span className="flex flex-wrap items-center gap-1">
                      <select
                        className="rounded-md border border-border bg-bg px-2 py-1 text-xs"
                        value={remoteMinutes}
                        onChange={(event) => setRemoteMinutes(Number(event.target.value))}
                        aria-label="Remote access time limit"
                      >
                        <option value={15}>15 minutes</option>
                        <option value={60}>1 hour</option>
                        <option value={240}>4 hours</option>
                        <option value={1440}>24 hours</option>
                      </select>
                      <select
                        className="rounded-md border border-border bg-bg px-2 py-1 text-xs"
                        value={remoteMode}
                        onChange={(event) => setRemoteMode(event.target.value === "rw" ? "rw" : "ro")}
                        aria-label="Remote access mode"
                      >
                        <option value="ro">Read-only</option>
                        <option value="rw">Read-and-write</option>
                      </select>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => {
                          setBusy(true);
                          void setMachineRemoteAccess({
                            data: { machineId: machine.machineId, enabled: true, minutes: remoteMinutes, mode: remoteMode },
                          })
                            .then((result) => {
                              if (result.ok) toast.success(result.message);
                              else toast.error(result.message);
                            })
                            .finally(() => setBusy(false));
                        }}
                      >
                        Turn remote access on
                      </Button>
                    </span>
                  ) : null}
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
                          data: { machineId: machine.machineId, askApproval: true },
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
