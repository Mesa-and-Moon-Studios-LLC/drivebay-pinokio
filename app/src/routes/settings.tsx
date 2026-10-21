import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowLeft, ExternalLink, HardDrive, Loader2, LogOut, Save } from "lucide-react";
import { toast } from "sonner";
import { authClient, signOut } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { RedirectToSignIn } from "@/lib/auth/gates";
import { emailToUsername } from "@/lib/files/identity";
import { getRouterHelp, getSettings, restartDrivebay, saveDriveAccess, savePortSettings, savePublicAccess, saveRemoteActions, saveServerLock } from "@/lib/files/api.functions";
import { isAndroidApp, settingsOnThisPc } from "@/lib/files/client-surface.mjs";
import { ANDROID_APK_URL, APP_VERSION, FEATURE_REQUEST_URL, PLAY_STORE_URL } from "@/lib/version";
import { clearStoredNext, rememberSettingsAfterLogin } from "@/lib/host-page.mjs";
import { ApiTokens } from "@/components/settings/api-tokens";
import { PhoneDriveMount } from "@/components/settings/phone-drive";
import { DonateMenu } from "@/components/settings/donate-menu";
import { HowToGuide } from "@/components/settings/how-to";
import { UPDATE_STATUS_EVENT } from "@/components/update-notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/settings")({ ssr: false, component: SettingsPage });

function SettingsPage() {
  const navigate = useNavigate();
  const { user, isPending } = useCurrentUserState();
  const [style, setStyle] = useState<"random" | "static">("static");
  const [port, setPort] = useState("8765");
  const [dataDir, setDataDir] = useState("");
  const [updateNote, setUpdateNote] = useState("");
  const [serverLock, setServerLock] = useState<{
    allowPortChangeFromUi: boolean;
    allowDelete: boolean;
    allowRename: boolean;
    allowCreateFolder: boolean;
    allowUpload: boolean;
    maxUploadMb: number;
    allowedRoots: string[];
    note: string;
    lockedOnServer: boolean;
    canEdit: boolean;
    lockFile: string;
  } | null>(null);
  const [allowPort, setAllowPort] = useState(true);
  const [allowDelete, setAllowDelete] = useState(true);
  const [allowRename, setAllowRename] = useState(true);
  const [allowMkdir, setAllowMkdir] = useState(true);
  const [allowUpload, setAllowUpload] = useState(true);
  const [maxUpload, setMaxUpload] = useState("512");
  const [allRoots, setAllRoots] = useState(true);
  const [chosenRoots, setChosenRoots] = useState<string[]>([]);
  const [folderPath, setFolderPath] = useState("");
  const [savingLock, setSavingLock] = useState(false);
  const [needsRestart, setNeedsRestart] = useState(false);
  const [restarting, setRestarting] = useState(false);
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
  const [reachMode, setReachMode] = useState<"regular" | "tailscale" | "both" | "unknown">("unknown");
  const [localIp, setLocalIp] = useState("");
  const [publicIp, setPublicIp] = useState("");
  const [publicAccess, setPublicAccess] = useState<{
    enabled: boolean;
    offAt: number | null;
    canEdit: boolean;
  } | null>(null);
  const [publicHours, setPublicHours] = useState<0 | 1 | 4 | 24>(1);
  const [savingPublic, setSavingPublic] = useState(false);
  const [remoteDelete, setRemoteDelete] = useState(true);
  const [remoteUpload, setRemoteUpload] = useState(true);
  const [savingRemote, setSavingRemote] = useState(false);

  useEffect(() => {
    if (!isAndroidApp()) return;
    const native = (window as Window & { DrivebayNative?: { openAppSettings?: () => void } }).DrivebayNative;
    native?.openAppSettings?.();
    void navigate({ to: "/" });
  }, [navigate]);

  useEffect(() => {
    clearStoredNext();
    if (!settingsOnThisPc(window.location.hostname)) {
      setLoaded(true);
      return;
    }
    let alive = true;
    getSettings()
      .then((s) => {
        if (!alive) return;
        setStyle(s.style);
        setPort(String(s.port));
        setDataDir(s.dataDir);
        if (s && typeof s === "object" && "serverLock" in s) {
          const lock = (s as { serverLock: NonNullable<typeof serverLock> }).serverLock;
          setServerLock(lock);
          setAllowPort(lock.allowPortChangeFromUi);
          setAllowDelete(lock.allowDelete);
          setAllowRename(lock.allowRename);
          setAllowMkdir(lock.allowCreateFolder);
          setAllowUpload(lock.allowUpload);
          setMaxUpload(String(lock.maxUploadMb));
          setAllRoots(lock.allowedRoots.length === 0);
          setChosenRoots(lock.allowedRoots);
        }
        if (s && typeof s === "object" && "driveAccess" in s && s.driveAccess) {
          const da = s.driveAccess as {
            drives: { id: string; path: string; label: string; kind: string; enabled: boolean }[];
            accessFile: string;
          };
          setDriveRows(da.drives ?? []);
          setDriveAccessFile(da.accessFile ?? "");
        }
        if (s && typeof s === "object" && "remoteActions" in s && s.remoteActions) {
          const remote = s.remoteActions as {
            allowDeleteFromOtherDevices?: boolean;
            allowUploadRenameFromOtherDevices?: boolean;
          };
          setRemoteDelete(remote.allowDeleteFromOtherDevices !== false);
          setRemoteUpload(remote.allowUploadRenameFromOtherDevices !== false);
        }
        setLoaded(true);
      })
      .catch(() => {
        if (alive) setLoaded(true);
      });
    getRouterHelp()
      .then((help) => {
        if (!alive) return;
        setReachMode(help.mode);
        setLocalIp(help.localIp || "");
        setPublicIp(help.publicIp || "");
        setPublicAccess(help.publicAccess ?? null);
      })
      .catch(() => {
        /* Settings still load when the router note cannot. */
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

  const onThisPc = settingsOnThisPc(window.location.hostname);
  const canEditLock = serverLock?.canEdit === true;

  async function checkForUpdates() {
    setUpdateNote("Checking for updates…");
    try {
      const res = await fetch("/api/update-status?force=1");
      const body = await res.json();
      window.dispatchEvent(new CustomEvent(UPDATE_STATUS_EVENT, { detail: body }));
      if (body?.action === "required" || body?.action === "optional") setUpdateNote("Update available.");
      else if (body?.reason === "unavailable") setUpdateNote("Drivebay could not reach GitHub.");
      else setUpdateNote("Drivebay is up to date.");
    } catch {
      setUpdateNote("Drivebay could not reach GitHub.");
    }
  }

  const ownerName = user.displayName || emailToUsername(user.primaryEmail);

  function rootKey(path: string) {
    return path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  }

  function rootSelected(path: string) {
    const key = rootKey(path);
    return chosenRoots.some((root) => rootKey(root) === key);
  }

  function toggleRoot(path: string) {
    setChosenRoots((prev) => {
      const key = rootKey(path);
      if (prev.some((root) => rootKey(root) === key)) return prev.filter((root) => rootKey(root) !== key);
      return [...prev, path];
    });
  }

  function addFolder() {
    const value = folderPath.trim();
    if (!value) return;
    if (!rootSelected(value)) setChosenRoots((prev) => [...prev, value]);
    setFolderPath("");
  }

  async function onSaveLock(e: React.FormEvent) {
    e.preventDefault();
    const mb = Number(maxUpload);
    if (!Number.isInteger(mb) || mb < 1 || mb > 8192) {
      toast.error("Max upload must be a whole number of MB from 1 to 8192.");
      return;
    }
    if (!allRoots && chosenRoots.length === 0) {
      toast.error("Choose at least one drive or folder, or switch to all drives.");
      return;
    }
    setSavingLock(true);
    try {
      const saved = await saveServerLock({
        data: {
          allowPortChangeFromUi: allowPort,
          allowDelete,
          allowRename,
          allowCreateFolder: allowMkdir,
          allowUpload,
          maxUploadMb: mb,
          allowedRoots: allRoots ? [] : chosenRoots,
        },
      });
      setServerLock(saved.serverLock);
      setNeedsRestart(saved.applied === "restart");
      if (saved.applied === "live") {
        toast.success("Server lock saved. It is in effect now.");
      } else {
        toast.error("Server lock was saved. Restart Drivebay to apply it.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save server lock");
    } finally {
      setSavingLock(false);
    }
  }

  async function onSavePublic(enabled: boolean) {
    setSavingPublic(true);
    try {
      const saved = await savePublicAccess({
        data: { enabled, hours: enabled ? publicHours : 0 },
      });
      setPublicAccess(saved);
      toast.success(saved.enabled ? "Public access: On" : "Public access: Off");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not change public access");
    } finally {
      setSavingPublic(false);
    }
  }

  async function onRestart() {
    setRestarting(true);
    try {
      const result = await restartDrivebay();
      if (result.ok) {
        toast.success("Restarting Drivebay.");
      } else {
        toast.error(result.message);
        setRestarting(false);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not restart Drivebay");
      setRestarting(false);
    }
  }

  async function onSavePort(e: React.FormEvent) {
    e.preventDefault();
    if (serverLock && !serverLock.allowPortChangeFromUi) {
      toast.error("Port changes are turned off in Server lock on this PC.");
      return;
    }
    const n = Number(port);
    setSavingPort(true);
    try {
      const next = await savePortSettings({
        data: { style, port: Number.isFinite(n) ? n : 8765 },
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

  async function onSaveRemote(nextDelete: boolean, nextUpload: boolean) {
    setRemoteDelete(nextDelete);
    setRemoteUpload(nextUpload);
    setSavingRemote(true);
    try {
      const saved = await saveRemoteActions({
        data: {
          allowDeleteFromOtherDevices: nextDelete,
          allowUploadRenameFromOtherDevices: nextUpload,
        },
      });
      setRemoteDelete(saved.allowDeleteFromOtherDevices);
      setRemoteUpload(saved.allowUploadRenameFromOtherDevices);
      toast.success("Saved for other devices.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save other-device access");
    } finally {
      setSavingRemote(false);
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
        {onThisPc ? (
        <>
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
          <p className="font-mono text-[10px] tracking-[0.16em] text-fg-subtle uppercase">Other devices</p>
          <div className="space-y-3 rounded-md border border-border bg-bg-elevated p-4">
            <p className="text-xs text-fg-muted">
              This PC can always delete, upload, and rename. Phones and other computers follow these switches.
              Rename is also how a file is moved. Both start on.
            </p>
            <label htmlFor="remote-delete" className="flex items-center gap-3 text-sm">
              <input
                id="remote-delete"
                type="checkbox"
                className="size-4 accent-fg"
                checked={remoteDelete}
                disabled={!loaded || savingRemote}
                onChange={(e) => void onSaveRemote(e.target.checked, remoteUpload)}
              />
              Allow delete from other devices
            </label>
            <label htmlFor="remote-upload" className="flex items-center gap-3 text-sm">
              <input
                id="remote-upload"
                type="checkbox"
                className="size-4 accent-fg"
                checked={remoteUpload}
                disabled={!loaded || savingRemote}
                onChange={(e) => void onSaveRemote(remoteDelete, e.target.checked)}
              />
              Allow upload/rename from other devices
            </label>
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
          {canEditLock && serverLock ? (
            <form className="space-y-3 rounded-md border border-border bg-bg-elevated p-4" onSubmit={(e) => void onSaveLock(e)}>
              <p className="text-xs text-fg-muted">
                These rules are enforced on the PC. Other devices can read them and cannot change them.
              </p>
              {(
                [
                  ["allow-port", "Port from this page", allowPort, setAllowPort],
                  ["allow-delete", "Delete", allowDelete, setAllowDelete],
                  ["allow-rename", "Rename", allowRename, setAllowRename],
                  ["allow-mkdir", "New folder", allowMkdir, setAllowMkdir],
                  ["allow-upload", "Upload", allowUpload, setAllowUpload],
                ] as const
              ).map(([id, label, checked, setChecked]) => (
                <label key={id} htmlFor={id} className="flex items-center gap-3 text-sm">
                  <input
                    id={id}
                    type="checkbox"
                    className="size-4 accent-fg"
                    checked={checked}
                    onChange={(e) => setChecked(e.target.checked)}
                  />
                  {label}
                </label>
              ))}
              <div>
                <Label htmlFor="max-upload">Max upload (MB)</Label>
                <Input
                  id="max-upload"
                  className="mt-1.5 font-mono"
                  inputMode="numeric"
                  value={maxUpload}
                  onChange={(e) => setMaxUpload(e.target.value.replace(/[^\d]/g, ""))}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setAllRoots(true)}
                  className={
                    allRoots
                      ? "rounded-sm border border-border-strong bg-bg-subtle px-3 py-3 text-left text-sm"
                      : "rounded-sm border border-border px-3 py-3 text-left text-sm text-fg-muted hover:bg-bg-subtle"
                  }
                >
                  <span className="block font-medium text-fg">All drives</span>
                  Every drive on this PC
                </button>
                <button
                  type="button"
                  onClick={() => setAllRoots(false)}
                  className={
                    !allRoots
                      ? "rounded-sm border border-border-strong bg-bg-subtle px-3 py-3 text-left text-sm"
                      : "rounded-sm border border-border px-3 py-3 text-left text-sm text-fg-muted hover:bg-bg-subtle"
                  }
                >
                  <span className="block font-medium text-fg">Choose drives</span>
                  Drives and folders
                </button>
              </div>
              {!allRoots && (
                <div className="space-y-2">
                  {driveRows.length ? (
                    <ul className="space-y-2">
                      {driveRows.map((d) => (
                        <li key={d.id} className="flex items-start gap-3 rounded-sm border border-border px-3 py-2">
                          <input
                            id={`root-${d.id}`}
                            type="checkbox"
                            className="mt-1 size-4 accent-fg"
                            checked={rootSelected(d.path)}
                            onChange={() => toggleRoot(d.path)}
                          />
                          <label htmlFor={`root-${d.id}`} className="min-w-0 flex-1 cursor-pointer">
                            <span className="block text-sm text-fg">{d.label}</span>
                            <span className="block break-all font-mono text-[11px] text-fg-subtle">{d.path}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-fg-subtle">No drives found on scan. Add a folder path below.</p>
                  )}
                  <div className="flex gap-2">
                    <Input
                      id="lock-folder"
                      value={folderPath}
                      placeholder="C:\Users\you\Downloads"
                      onChange={(e) => setFolderPath(e.target.value)}
                    />
                    <Button type="button" variant="outline" onClick={addFolder}>
                      Add folder
                    </Button>
                  </div>
                  {chosenRoots.filter((root) => !driveRows.some((d) => rootKey(d.path) === rootKey(root))).length ? (
                    <ul className="space-y-1">
                      {chosenRoots
                        .filter((root) => !driveRows.some((d) => rootKey(d.path) === rootKey(root)))
                        .map((root) => (
                          <li key={root} className="flex items-center justify-between gap-2 text-xs">
                            <span className="break-all font-mono text-fg-muted">{root}</span>
                            <button type="button" className="text-fg-subtle underline" onClick={() => toggleRoot(root)}>
                              Remove
                            </button>
                          </li>
                        ))}
                    </ul>
                  ) : null}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={!loaded || savingLock}>
                  {savingLock ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                  Save server lock
                </Button>
                {needsRestart ? (
                  <Button type="button" variant="outline" disabled={restarting} onClick={() => void onRestart()}>
                    {restarting ? <Loader2 className="size-4 animate-spin" /> : null}
                    Restart Drivebay
                  </Button>
                ) : null}
              </div>
              <p className="break-all font-mono text-[11px] text-fg-subtle">{serverLock.lockFile}</p>
            </form>
          ) : (
            <div className="space-y-2 rounded-md border border-border bg-bg-elevated p-4 text-sm">
              <p className="text-xs text-fg-muted">
                These flags are enforced on the PC. Web and APK clients can read them but cannot change them.
                Change them in Settings on the PC that runs Drivebay.
              </p>
              {onThisPc && serverLock && !serverLock.canEdit ? (
                <p className="text-xs text-fg">
                  This page is on this PC, but the server did not see a loopback connection, so the lock stays read-only.
                </p>
              ) : null}
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
                    {serverLock.allowedRoots.length ? serverLock.allowedRoots.join(", ") : "(all drives)"}
                  </li>
                  {serverLock.note ? <li className="text-fg">note: {serverLock.note}</li> : null}
                  <li className="break-all text-fg-subtle">{serverLock.lockFile}</li>
                </ul>
              ) : (
                <p className="text-xs text-fg-subtle">Loading lock policy…</p>
              )}
            </div>
          )}
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
              After saving, stop Drivebay in Pinokio and click Start. Forward a static port on your router. The suggested port is 8765. Pinokio's Caddy uses 42000-42999 while Pinokio is running.
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

        {reachMode === "both" && publicAccess ? (
          <section className="space-y-3">
            <p className="font-mono text-[10px] tracking-[0.16em] text-fg-subtle uppercase">Public access</p>
            <div className="space-y-3 rounded-md border border-border bg-bg-elevated p-4 text-xs text-fg-muted">
              <p className="text-sm text-fg">Public access: {publicAccess.enabled ? "On" : "Off"}</p>
              <p>
                {publicAccess.enabled
                  ? "Devices that are not on this PC and not on Tailscale can open the sign-in page."
                  : "Devices that are not on this PC and not on Tailscale see a refusal page. They do not get a sign-in page. Tailscale still reaches Drivebay."}
              </p>
              {publicAccess.enabled && publicAccess.offAt ? (
                <p>Turns off at {new Date(publicAccess.offAt).toLocaleString()}.</p>
              ) : null}
              {publicAccess.canEdit ? (
                <div className="space-y-3">
                  {publicAccess.enabled ? null : (
                    <div>
                      <Label htmlFor="public-hours">Turn off after</Label>
                      <select
                        id="public-hours"
                        className="mt-1.5 block w-full rounded-sm border border-border bg-bg px-3 py-2 text-sm text-fg"
                        value={publicHours}
                        onChange={(e) => setPublicHours(Number(e.target.value) as 0 | 1 | 4 | 24)}
                      >
                        <option value={0}>Stay on until you turn it off</option>
                        <option value={1}>1 hour</option>
                        <option value={4}>4 hours</option>
                        <option value={24}>24 hours</option>
                      </select>
                    </div>
                  )}
                  <Button
                    type="button"
                    disabled={savingPublic}
                    onClick={() => void onSavePublic(!publicAccess.enabled)}
                  >
                    {savingPublic ? <Loader2 className="size-4 animate-spin" /> : null}
                    {publicAccess.enabled ? "Turn public access off" : "Turn public access on"}
                  </Button>
                </div>
              ) : (
                <p>Public access can only be changed on this PC.</p>
              )}
            </div>
          </section>
        ) : null}

        {reachMode === "regular" || reachMode === "both" ? (
          <section className="space-y-3">
            <p className="font-mono text-[10px] tracking-[0.16em] text-fg-subtle uppercase">
              {reachMode === "both" ? "Tailscale + Local (Both)" : "No Tailscale (Regular mode)"}
            </p>
            <div className="space-y-3 rounded-md border border-border bg-bg-elevated p-4 text-xs text-fg-muted">
              <p>Other devices outside your network reach this PC only after the router forwards the port.</p>
              {reachMode === "both" ? (
                <p>Public access starts off. These steps matter when you turn that path on. Tailscale keeps working either way.</p>
              ) : null}
              <ol className="list-decimal space-y-2 pl-5">
                <li>
                  This PC&apos;s local IP is{" "}
                  <span className="font-mono text-fg">{localIp || "not found. Run ipconfig and use the IPv4 address."}</span>.
                </li>
                <li>
                  Log in to the router. The page is usually{" "}
                  <span className="font-mono text-fg">http://192.168.0.1</span> or{" "}
                  <span className="font-mono text-fg">http://192.168.1.1</span>.
                </li>
                <li>
                  Add a port forward for TCP <span className="font-mono text-fg">{port || "the port"}</span> to that local IP.
                </li>
                <li>Give this PC a reserved or static IP in the router&apos;s DHCP settings so the address does not change.</li>
                <li>
                  This PC&apos;s public IP is{" "}
                  <span className="font-mono text-fg">{publicIp || "not found. Search the web for what is my ip."}</span>.
                  From outside the network, open{" "}
                  <span className="font-mono text-fg">
                    {publicIp ? `http://${publicIp}:${port || "port"}/` : `http://<public-ip>:${port || "port"}/`}
                  </span>
                  .
                </li>
                <li>Some ISPs use CGNAT and block this. Tailscale is the easy fallback.</li>
              </ol>
              <p className="text-fg">Use a strong password. It is the lock for every drive on this PC.</p>
            </div>
          </section>
        ) : null}

        <section className="space-y-3">
          <p className="font-mono text-[10px] tracking-[0.16em] text-fg-subtle uppercase">Get the Android app</p>
          <div className="rounded-md border border-border bg-bg-elevated p-4">
            <p className="text-xs text-fg-muted">
              Install Drivebay on a phone. The APK is on the latest GitHub release.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <a
                href={ANDROID_APK_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-fg-muted underline-offset-4 hover:text-fg hover:underline"
              >
                Android APK
                <ExternalLink className="size-3.5" />
              </a>
              {PLAY_STORE_URL ? (
                <Button asChild variant="outline" size="sm">
                  <a href={PLAY_STORE_URL} target="_blank" rel="noreferrer">
                    Google Play
                  </a>
                </Button>
              ) : null}
            </div>
          </div>
        </section>

        <PhoneDriveMount />

        <ApiTokens />

        <HowToGuide />

        <DonateMenu />

        <section className="space-y-3">
          <p className="font-mono text-[10px] tracking-[0.16em] text-fg-subtle uppercase">About</p>
          <div className="rounded-md border border-border bg-bg-elevated p-4">
            <p className="text-sm text-fg">Drivebay {APP_VERSION}</p>
            {onThisPc ? (
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Button type="button" variant="outline" size="sm" onClick={() => void checkForUpdates()}>
                  Check for updates
                </Button>
                {updateNote ? <span className="text-xs text-fg-muted">{updateNote}</span> : null}
              </div>
            ) : null}
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
        </>
        ) : (
          <section className="space-y-3">
            <p className="font-mono text-[10px] tracking-[0.16em] text-fg-subtle uppercase">This phone</p>
            <div className="space-y-3 rounded-md border border-border bg-bg-elevated p-4 text-sm">
              <p>Server settings stay on this PC.</p>
              <p className="text-xs text-fg-muted">
                Browse, download, and upload from this device. Lock signs out. In the Android app, App settings
                holds the server address and Wi-Fi downloads.
              </p>
              <Link to="/" className="inline-flex text-sm text-fg-muted underline-offset-4 hover:text-fg hover:underline">
                Back to files
              </Link>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
