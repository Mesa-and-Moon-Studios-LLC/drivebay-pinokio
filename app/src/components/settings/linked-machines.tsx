import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  approveLinkedRequest,
  denyLinkedRequest,
  connectLinkedMachine,
  createLinkedCode,
  disconnectLinkedMachine,
  finishLinkedMachine,
  getLinkedStatus,
  listLinkedMachines,
  revokeLinkedGrant,
  saveLinkedShares,
  saveMesaSession,
  setMachineRemoteAccess,
  signOutMesa,
} from "@/lib/files/linked-machines.functions";
import { VaultLock } from "@/components/settings/vault-lock";
import { LinkedBrowsePanel } from "@/components/settings/linked-browse";
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
export const SIGN_IN_SETUP_HINT = "Sign-in is not set up on this machine yet. Open Settings, Advanced, Sign-in setup.";

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
  pairs: {
    pending: { id: string; name: string; join?: boolean; fromId?: string; hostId?: string; hostName?: string }[];
    grants: { id: string; name: string; createdAt: number; scope: "full" | "shares" }[];
  };
  links: { machineId: string; label: string; paired: boolean; pending?: boolean; via: string; scope?: string }[];
  self: { displayName: string } | null;
  warning: string;
  vault?: { ready?: boolean; unlocked?: boolean; hasPassphrase?: boolean; hasPasskey?: boolean; hasRecovery?: boolean; cannotRecover?: string };
  remoteAccess?: { enabled?: boolean; offAt?: number | null; mode?: string; source?: string; byName?: string };
  edition?: {
    edition: string;
    remoteAccess: boolean;
    remote24h: boolean;
    sharedFolderLimit: number;
    remoteAccessMessage: string;
    remote24hMessage: string;
  };
};

type LinkedCtx = ReturnType<typeof useLinkedState>;
const LinkedContext = createContext<LinkedCtx | null>(null);

function useLinkedState() {
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
  const [browsing, setBrowsing] = useState<{ machineId: string; title: string } | null>(null);
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
      toast.error(SIGN_IN_SETUP_HINT);
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
      toast.error(SIGN_IN_SETUP_HINT);
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

  async function join(machine: MachineRow, acceptRisk = false) {
    setBusy(true);
    try {
      const result = await connectLinkedMachine({
        data: { machineId: machine.machineId, askApproval: true, join: true, acceptRisk },
      });
      if ("needsRisk" in result && result.needsRisk) {
        const ok = window.confirm(`${result.message}\n\nJoin this machine over the public internet?`);
        if (ok) {
          setBusy(false);
          await join(machine, true);
          return;
        }
        return;
      }
      if ("needsPassword" in result && result.needsPassword) {
        toast.error(result.message);
        await refresh();
        return;
      }
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
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

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refresh().catch(() => {});
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  const signedIn = status?.account.signedIn === true;
  return {
    status,
    machines,
    listNote,
    name,
    setName,
    hidden,
    setHidden,
    direct,
    setDirect,
    publicHost,
    setPublicHost,
    folders,
    setFolders,
    folderPath,
    setFolderPath,
    folderAccess,
    setFolderAccess,
    code,
    setCode,
    pairCode,
    email,
    setEmail,
    password,
    setPassword,
    busy,
    setBusy,
    remoteMinutes,
    setRemoteMinutes,
    remoteMode,
    setRemoteMode,
    browsing,
    setBrowsing,
    refresh,
    submitEmail,
    startProvider,
    saveShareForm,
    showCode,
    connect,
    join,
    finish,
    signedIn,
  };
}

export function LinkedProvider({ children }: { children: ReactNode }) {
  const value = useLinkedState();
  return <LinkedContext.Provider value={value}>{children}</LinkedContext.Provider>;
}

function useLinked() {
  const value = useContext(LinkedContext);
  if (!value) throw new Error("LinkedProvider is missing.");
  return value;
}

function Card({ children }: { children: ReactNode }) {
  return <div className="space-y-4 rounded-md border border-border bg-bg-elevated p-4 text-sm">{children}</div>;
}

function Sub({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-fg">{title}</p>
      {children}
    </div>
  );
}

/** Account group: the Mesa and Moon sign-in. */
export function MesaAccountSection() {
  const { status, signedIn, busy, email, setEmail, password, setPassword, startProvider, submitEmail, refresh } = useLinked();
  return (
    <Card>
      <div>
        <p className="text-base font-medium text-fg">Mesa and Moon account</p>
        <p className="mt-1 text-xs text-fg-muted">
          Optional. Drivebay works without it. Your files never touch our servers. The account only stores how to
          reach each of your machines, and your machine list is encrypted with your join password.
        </p>
      </div>
      {signedIn ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-fg">Signed in as {status?.account.email || status?.account.displayName}</p>
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
                Send reset link
              </Button>
            </div>
            <p className="text-xs text-fg-muted">
              This password is sent to Mesa and Moon sign-in and is not saved here. If the email already belongs to
              Google or Apple, use that button. It stays one account.
            </p>
          </form>
        </div>
      )}
    </Card>
  );
}

/** Advanced group: developer-only sign-in setup. */
export function SignInSetupNote() {
  const { status } = useLinked();
  return (
    <div className="space-y-1 text-xs text-fg-muted">
      <p className="text-sm text-fg">Sign-in setup</p>
      <p>
        {status?.config.ready
          ? "Sign-in is set up on this machine."
          : "Sign-in is not set up on this machine. Put the mesa-firebase.json file in this machine's data folder, then restart Drivebay. Drivebay stays fully usable without it."}
      </p>
    </div>
  );
}

/** This machine group: how this machine appears on the login. */
export function ThisMachineSection() {
  const { name, setName, hidden, setHidden, busy, saveShareForm, signedIn } = useLinked();
  return (
    <Card>
      <div className="space-y-1">
        <Label htmlFor="machine-name">Name on your login</Label>
        <Input id="machine-name" value={name} onChange={(event) => setName(event.target.value)} />
        <p className="text-xs text-fg-muted">
          {signedIn ? "This is how your other machines see this one." : "Used once you sign in to Mesa and Moon."}
        </p>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={hidden} onChange={(event) => setHidden(event.target.checked)} />
        <span>Hide this machine from your other machines.</span>
      </label>
      <Button type="button" size="sm" disabled={busy} onClick={() => void saveShareForm()}>
        Save
      </Button>
    </Card>
  );
}

function PendingJoinList({ pending, onDone }: { pending: NonNullable<Status["pairs"]>["pending"]; onDone: () => void }) {
  return (
    <>
      {pending.map((row) => (
        <div key={row.id} className="flex flex-wrap items-center gap-2" data-testid="join-request">
          <span className="min-w-0 flex-1 text-xs">
            <span className="text-sm text-fg">{row.name || "A machine"}</span> wants to join
            {row.hostName && row.hostName !== "this machine" ? ` on ${row.hostName}` : ""}.{" "}
            {row.join
              ? "Its join password and device key checked out."
              : "It did not send the join password, so it would only see your shared folders."}
          </span>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              void approveLinkedRequest({
                data: { id: row.id, hostId: row.hostId, fromId: row.fromId, name: row.name },
              }).then(() => onDone());
            }}
          >
            Approve
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              void denyLinkedRequest({ data: { id: row.id, hostId: row.hostId } }).then(() => onDone());
            }}
          >
            Deny
          </Button>
        </div>
      ))}
    </>
  );
}

/** Shown at the top of Settings so a pending join is not buried under Account or Drives. */
export function JoinRequestsBanner() {
  const { status, refresh } = useLinked();
  const pending = status?.pairs.pending || [];
  if (!pending.length) return null;
  return (
    <div className="rounded-md border-2 border-fg bg-bg-elevated p-4" data-testid="join-request-banner">
      <p className="text-sm font-medium text-fg">Join requests</p>
      <p className="mb-3 text-xs text-fg-muted">A machine on your login is waiting. Approve it here, or deny it.</p>
      <div className="space-y-2">
        <PendingJoinList pending={pending} onDone={() => void refresh()} />
      </div>
    </div>
  );
}

/** My machines group: join password, join requests, trusted devices, and your other machines. */
export function MyMachinesSection() {
  const {
    status, signedIn, machines, listNote, busy, setBusy, remoteMinutes, setRemoteMinutes,
    remoteMode, setRemoteMode, browsing, setBrowsing, join, finish, refresh,
  } = useLinked();
  const vaultReady = status?.vault?.ready === true;
  const pending = status?.pairs.pending || [];
  const grants = status?.pairs.grants || [];
  return (
    <Card>
      <p className="text-xs text-fg-muted">
        Your machines on the same login see each other&apos;s whole drives. A new machine must know your join password,
        and a machine you already trust must approve it. A stolen login alone cannot do either.
      </p>

      <VaultLock vault={status?.vault} config={status?.config} signedIn={signedIn} onDone={() => void refresh()} />

      {pending.length ? (
        <Sub title="Join requests">
          <PendingJoinList pending={pending} onDone={() => void refresh()} />
        </Sub>
      ) : null}

      <Sub title="Trusted devices">
        {grants.length === 0 ? <p className="text-xs text-fg-muted">No device has been approved on this machine yet.</p> : null}
        {grants.map((grant) => (
          <div key={grant.id} className="flex flex-wrap items-center gap-2" data-testid="trusted-device">
            <div className="min-w-0 flex-1">
              <p className="text-sm text-fg">{grant.name || grant.id}</p>
              <p className="text-xs text-fg-muted">
                {grant.scope === "full" ? "Trusted. Can browse all drives on this machine." : "Paired with a code. Shared folders only."}
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                void revokeLinkedGrant({ data: { id: grant.id } }).then(() => refresh());
              }}
            >
              Forget
            </Button>
          </div>
        ))}
      </Sub>

      <Sub title="Your other machines">
        {listNote ? <p className="text-xs text-fg-muted">{listNote}</p> : null}
        {!signedIn ? <p className="text-xs text-fg-muted">Sign in to see the other machines on this login.</p> : null}
        {signedIn && machines.length === 0 && !listNote ? (
          <p className="text-xs text-fg-muted">No other machines yet. Sign in on each one.</p>
        ) : null}
        {signedIn && !vaultReady && machines.length > 0 ? (
          <p className="text-xs text-fg-muted">
            Enter your join password above first, or set one if this account does not have one yet. Own machines join
            with that password and an approval, not a 6-digit code.
          </p>
        ) : null}
        {machines.map((machine) => {
          const link = status?.links?.find((row) => row.machineId === machine.machineId);
          const granted = Boolean(link?.paired);
          return (
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
                {granted ? (
                  <Button type="button" size="sm" disabled={busy} onClick={() => setBrowsing({ machineId: machine.machineId, title: machine.displayName })}>
                    Open drives
                  </Button>
                ) : (
                  <Button type="button" size="sm" disabled={busy} onClick={() => void join(machine)} data-testid="own-machine-join">
                    Join
                  </Button>
                )}
                {link?.pending && !granted ? (
                  <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void finish(machine.machineId)}>
                    Check approval
                  </Button>
                ) : null}
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
          );
        })}
        {browsing ? (
          <LinkedBrowsePanel
            machineId={browsing.machineId}
            title={browsing.title}
            onClose={() => setBrowsing(null)}
          />
        ) : null}
        <p className="text-xs text-fg-muted">
          <span className="text-fg">Join</span> uses your join password and waits for a trusted device on that machine
          to approve. <span className="text-fg">Open drives</span> browses a machine that already approved you. The
          6-digit code in Sharing with others is only for someone else&apos;s device to open shared folders.
        </p>
      </Sub>
    </Card>
  );
}

/** Sharing with others group: shared folders, 6-digit code, and remote access. */
export function SharingSection() {
  const {
    status, signedIn, machines, busy, setBusy, folders, setFolders, folderPath, setFolderPath, folderAccess, setFolderAccess,
    direct, setDirect, publicHost, setPublicHost, saveShareForm, showCode, pairCode, remoteMinutes, setRemoteMinutes,
    remoteMode, setRemoteMode, refresh,
  } = useLinked();
  const tailnetMachines = machines.filter((machine) => !machine.self && machine.connect?.via === "tailscale");
  return (
    <Card>
      <p className="text-xs text-fg-muted">
        Everyone who is not one of your own machines only sees what you share here. Your own trusted machines do not
        need a shared folder.
      </p>
      <Sub title="Shared folders">
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
      </Sub>

      <Sub title="6-digit code">
        <p className="text-xs text-fg-muted">
          Lets someone else's device open the shared folders above. Give it to them in person. It expires in 10 minutes.
        </p>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void showCode()}>
          Show a 6-digit code
        </Button>
        {pairCode ? <p className="font-mono text-lg tracking-widest text-fg">{pairCode}</p> : null}
      </Sub>

      <Sub title="Remote access (outside Tailscale)">
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={direct} onChange={(event) => setDirect(event.target.checked)} />
          <span>I opened this port on the public internet myself. {status?.warning}</span>
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
        {signedIn && tailnetMachines.length ? (
          <div className="space-y-2">
            <p className="text-xs text-fg-muted">
              Turn the port forward on for another machine on your Tailscale network. It switches itself off after the
              time you pick.
            </p>
            {status?.edition && !status.edition.remoteAccess ? (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-fg" role="status" data-testid="remote-upgrade-note">
                {status.edition.remoteAccessMessage}{" "}
                <a className="underline underline-offset-4" href="#edition">
                  Open Edition settings
                </a>
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <select
                className="rounded-md border border-border bg-bg px-2 py-1 text-xs"
                value={remoteMinutes}
                onChange={(event) => setRemoteMinutes(Number(event.target.value))}
                aria-label="Remote access time limit"
              >
                <option value={15}>15 minutes</option>
                <option value={60}>1 hour</option>
                <option value={240}>4 hours</option>
                <option value={1440} disabled={status?.edition ? !status.edition.remote24h : false}>
                  {status?.edition && !status.edition.remote24h ? "24 hours (Elite)" : "24 hours"}
                </option>
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
            </div>
            {tailnetMachines.map((machine) => (
              <div key={machine.machineId} className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 text-sm text-fg">{machine.displayName}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy || (status?.edition ? !status.edition.remoteAccess : false)}
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
                  Turn on
                </Button>
              </div>
            ))}
          </div>
        ) : null}
        <RemoteAccessBanner access={status?.remoteAccess} machineId="self" onChange={() => void refresh()} />
      </Sub>

      <Button type="button" size="sm" disabled={busy} onClick={() => void saveShareForm()}>
        Save
      </Button>
    </Card>
  );
}
