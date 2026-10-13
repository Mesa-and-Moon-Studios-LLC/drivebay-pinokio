import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowLeft, ExternalLink, HardDrive, Loader2, LogOut, Save } from "lucide-react";
import { toast } from "sonner";
import { authClient, signOut } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { RedirectToSignIn } from "@/lib/auth/gates";
import { emailToUsername } from "@/lib/files/identity";
import { getSettings, saveDriveAccess, savePortSettings } from "@/lib/files/api.functions";
import { APP_VERSION, FEATURE_REQUEST_URL } from "@/lib/version";
import { clearStoredNext, pageAfterSignIn, rememberSettingsAfterLogin } from "@/lib/host-page.mjs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/settings")({ ssr: false, component: SettingsPage });

function SettingsPage() {
  const navigate = useNavigate();
  const { user, isPending } = useCurrentUserState();
  const [style, setStyle] = useState<"random" | "static">("static");
  const [port, setPort] = useState("42013");
  const [dataDir, setDataDir] = useState("");
  const [serverLock, setServerLock] = useState<{
    allowPortChangeFromUi: boolean;
    allowDelete: boolean;
    allowRename: boolean;
    allowCreateFolder: boolean;
    allowUpload: boolean;
    maxUploadMb: number;
    allowedRoots: string[];
    note: string;
    lockedOnServer: true;
    lockFile: string;
  } | null>(null);
  const [driveRows, setDriveRows] = useState<
    { id: string; path: string; label: string; kind: string; enabled: boolean }[]
  >([]);
  const [driveAccessFile, setDriveAccessFile] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [savingPort, setSavingPort] = useState(false);
  const [savingDrives, setSavingDrives] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [savingPass, setSavingPass] = useState(false);

  useEffect(() => {
    clearStoredNext();
    let alive = true;
    getSettings()
      .then((s) => {
        if (!alive) return;
        setStyle(s.style);
        setPort(String(s.port));
        setDataDir(s.dataDir);
        // serverLock is host-only policy; never writable from this UI
        if (s && typeof s === "object" && "serverLock" in s) {
          setServerLock((s as { serverLock: NonNullable<typeof serverLock> }).serverLock);
        }
        if (s && typeof s === "object" && "driveAccess" in s && s.driveAccess) {
          const da = s.driveAccess as {
            drives: { id: string; path: string; label: string; kind: string; enabled: boolean }[];
            accessFile: string;
          };
          setDriveRows(da.drives ?? []);
          setDriveAccessFile(da.accessFile ?? "");
        }
        setLoaded(true);
      })
      .catch(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (isPending) {
    return (
      <div className="grid min-h-dvh place-items-center bg-bg">
        <Loader2 className="size-6 animate-spin text-fg-subtle" />
      </div>
    );
  }
  if (!user) {
    rememberSettingsAfterLogin();
    return <RedirectToSignIn />;
  }

  const onThisPc = pageAfterSignIn(window.location.hostname, null) === "/settings";

  const ownerName = user.displayName || emailToUsername(user.primaryEmail);

  async function onSavePort(e: React.FormEvent) {
    e.preventDefault();
    if (serverLock && !serverLock.allowPortChangeFromUi) {
      toast.error("Port changes are locked on the server (edit data/server-lock.json on the PC).");
      return;
    }
    const n = Number(port);
    setSavingPort(true);
    try {
      const next = await savePortSettings({
        data: { style, port: Number.isFinite(n) ? n : 42013 },
      });
      setStyle(next.style);
      setPort(String(next.port));
      toast.success(
        next.style === "static"
          ? `Port saved: ${next.port}. Stop and Start Drivebay to apply.`
          : "Random port saved. Stop and Start Drivebay to apply.",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save port");
    } finally {
      setSavingPort(false);
    }
  }

  function toggleDrive(id: string) {
    setDriveRows((rows) =>
      rows.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)),
    );
  }

  async function onSaveDrives(e: React.FormEvent) {
    e.preventDefault();
    setSavingDrives(true);
    try {
      const disabledIds = driveRows.filter((r) => !r.enabled).map((r) => r.id);
      const next = await saveDriveAccess({ data: { disabledIds } });
      setDriveRows(next.drives ?? []);
      setDriveAccessFile(next.accessFile ?? "");
      toast.success(
        disabledIds.length
          ? `Saved — ${disabledIds.length} drive${disabledIds.length === 1 ? "" : "s"} off`
          : "Saved — all scanned drives on",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save drive access");
    } finally {
      setSavingDrives(false);
    }
  }

  async function onChangePassword(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword.length < 8) {
      toast.error("Use at least 8 characters");
      return;
    }
    if (newPassword !== confirm) {
      toast.error("Passwords do not match");
      return;
    }
    setSavingPass(true);
    try {
      const { error } = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });
      if (error) throw new Error(error.message ?? "Could not change password");
      setCurrentPassword("");
      setNewPassword("");
      setConfirm("");
      toast.success("Password updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not change password");
    } finally {
      setSavingPass(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col bg-bg text-fg">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 md:px-4">
        {onThisPc ? null : (
          <Button variant="ghost" size="icon-sm" aria-label="Back" onClick={() => void navigate({ to: "/" })}>
            <ArrowLeft className="size-4" />
          </Button>
        )}
        <HardDrive className="size-4 text-fg-muted" strokeWidth={1.7} />
        <span className="font-mono text-[11px] tracking-[0.16em] text-fg-subtle uppercase">Settings</span>
        <span className="font-mono text-[11px] text-fg-subtle">{APP_VERSION}</span>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden max-w-28 truncate text-xs text-fg-muted sm:block">{ownerName}</span>
          <Button variant="ghost" size="sm" onClick={() => void signOut("/login")}>
            <LogOut className="size-3.5" />
            Lock
          </Button>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-8 px-4 py-8">
        <section className="space-y-3">
          <p className="font-mono text-[10px] tracking-[0.16em] text-fg-subtle uppercase">Account</p>
          <div className="rounded-md border border-border bg-bg-elevated p-4">
            <Label htmlFor="username">Username</Label>
            <Input id="username" className="mt-1.5" value={ownerName} readOnly />
            <p className="mt-2 text-xs text-fg-muted">
              This lock stays after Update. It is stored in a data folder outside the files Git replaces.
            </p>
          </div>
        </section>

        <section className="space-y-3">
          <p className="font-mono text-[10px] tracking-[0.16em] text-fg-subtle uppercase">Password</p>
          <form className="space-y-3 rounded-md border border-border bg-bg-elevated p-4" onSubmit={onChangePassword}>
            <div>
              <Label htmlFor="current">Current password</Label>
              <Input
                id="current"
                type="password"
                className="mt-1.5"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
              />
            </div>
            <div>
              <Label htmlFor="next">New password</Label>
              <Input
                id="next"
                type="password"
                className="mt-1.5"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            <div>
              <Label htmlFor="confirm">Confirm new password</Label>
              <Input
                id="confirm"
                type="password"
                className="mt-1.5"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            <Button type="submit" disabled={savingPass}>
              {savingPass ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              Update password
            </Button>
          </form>
        </section>

        <section className="space-y-3">
          <p className="font-mono text-[10px] tracking-[0.16em] text-fg-subtle uppercase">Drive access</p>
          <form className="space-y-3 rounded-md border border-border bg-bg-elevated p-4" onSubmit={onSaveDrives}>
            <p className="text-xs text-fg-muted">
              On Start / Settings load, Drivebay scans every drive on this PC. Turn any drive off to hide it from the
              sidebar and block browse/download/upload there. Saved in data so Update keeps your choices.
            </p>
            {driveRows.length ? (
              <ul className="space-y-2">
                {driveRows.map((d) => (
                  <li
                    key={d.id}
                    className="flex items-start gap-3 rounded-sm border border-border px-3 py-2"
                  >
                    <input
                      id={`drive-${d.id}`}
                      type="checkbox"
                      className="mt-1 size-4 accent-fg"
                      checked={d.enabled}
                      onChange={() => toggleDrive(d.id)}
                    />
                    <label htmlFor={`drive-${d.id}`} className="min-w-0 flex-1 cursor-pointer">
                      <span className="block text-sm text-fg">{d.label}</span>
                      <span className="block break-all font-mono text-[11px] text-fg-subtle">{d.path}</span>
                      <span className="block text-[11px] text-fg-muted">{d.kind}</span>
                    </label>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-fg-subtle">{loaded ? "No drives found on scan." : "Scanning drives…"}</p>
            )}
            {driveAccessFile ? (
              <p className="break-all font-mono text-[11px] text-fg-subtle">{driveAccessFile}</p>
            ) : null}
            <Button type="submit" disabled={!loaded || savingDrives || !driveRows.length}>
              {savingDrives ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              Save drive access
            </Button>
          </form>
        </section>

        <section className="space-y-3">
          <p className="font-mono text-[10px] tracking-[0.16em] text-fg-subtle uppercase">Server lock (host only)</p>
          <div className="space-y-2 rounded-md border border-border bg-bg-elevated p-4 text-sm">
            <p className="text-xs text-fg-muted">
              These flags are enforced on the PC. Web and APK clients can read them but cannot change them.
              Edit <span className="font-mono">data/server-lock.json</span> on the host, then restart Drivebay.
            </p>
            {serverLock ? (
              <ul className="space-y-1 font-mono text-[11px] text-fg-muted">
                <li>port from UI: {serverLock.allowPortChangeFromUi ? "allowed" : "LOCKED"}</li>
                <li>delete: {serverLock.allowDelete ? "allowed" : "LOCKED"}</li>
                <li>rename: {serverLock.allowRename ? "allowed" : "LOCKED"}</li>
                <li>mkdir: {serverLock.allowCreateFolder ? "allowed" : "LOCKED"}</li>
                <li>upload: {serverLock.allowUpload ? "allowed" : "LOCKED"}</li>
                <li>max upload: {serverLock.maxUploadMb} MB</li>
                <li>
                  roots:{" "}
                  {serverLock.allowedRoots.length
                    ? serverLock.allowedRoots.join(", ")
                    : "(all drives)"}
                </li>
                {serverLock.note ? <li className="text-fg">note: {serverLock.note}</li> : null}
                <li className="break-all text-fg-subtle">{serverLock.lockFile}</li>
              </ul>
            ) : (
              <p className="text-xs text-fg-subtle">Loading lock policy…</p>
            )}
          </div>
        </section>

        <section className="space-y-3">
          <p className="font-mono text-[10px] tracking-[0.16em] text-fg-subtle uppercase">Port</p>
          <form className="space-y-3 rounded-md border border-border bg-bg-elevated p-4" onSubmit={onSavePort}>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setStyle("static")}
                className={
                  style === "static"
                    ? "rounded-sm border border-border-strong bg-bg-subtle px-3 py-3 text-left text-sm"
                    : "rounded-sm border border-border px-3 py-3 text-left text-sm text-fg-muted hover:bg-bg-subtle"
                }
              >
                <span className="block font-medium text-fg">Static</span>
                Same port every Start
              </button>
              <button
                type="button"
                onClick={() => setStyle("random")}
                className={
                  style === "random"
                    ? "rounded-sm border border-border-strong bg-bg-subtle px-3 py-3 text-left text-sm"
                    : "rounded-sm border border-border px-3 py-3 text-left text-sm text-fg-muted hover:bg-bg-subtle"
                }
              >
                <span className="block font-medium text-fg">Random</span>
                New port each Start
              </button>
            </div>
            {style === "static" && (
              <div>
                <Label htmlFor="port">Port number</Label>
                <Input
                  id="port"
                  className="mt-1.5 font-mono"
                  inputMode="numeric"
                  value={port}
                  onChange={(e) => setPort(e.target.value.replace(/[^\d]/g, ""))}
                />
              </div>
            )}
            <p className="text-xs text-fg-muted">
              After saving, stop Drivebay in Pinokio and click Start. Forward a static port on your router.
            </p>
            <Button
              type="submit"
              disabled={!loaded || savingPort || serverLock?.allowPortChangeFromUi === false}
            >
              {savingPort ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              {serverLock?.allowPortChangeFromUi === false ? "Port locked on server" : "Save port"}
            </Button>
          </form>
        </section>

        <section className="space-y-3">
          <p className="font-mono text-[10px] tracking-[0.16em] text-fg-subtle uppercase">About</p>
          <div className="rounded-md border border-border bg-bg-elevated p-4">
            <p className="text-sm text-fg">Drivebay {APP_VERSION}</p>
            <p className="mt-1 text-xs text-fg-muted">
              Password-locked file browser for this machine. Feature ideas go to GitHub so they stay in one place.
            </p>
            <a
              href={FEATURE_REQUEST_URL}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-flex items-center gap-1.5 text-sm text-fg-muted underline-offset-4 hover:text-fg hover:underline"
            >
              Request a feature
              <ExternalLink className="size-3.5" />
            </a>
            <p className="mt-2 break-all font-mono text-[11px] text-fg-subtle">{dataDir || "…"}</p>
            {onThisPc ? null : (
              <Link to="/" className="mt-4 inline-flex text-sm text-fg-muted underline-offset-4 hover:text-fg hover:underline">
                Back to files
              </Link>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
