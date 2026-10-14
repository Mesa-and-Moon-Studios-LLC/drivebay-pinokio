import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { HardDrive } from "lucide-react";
import { toast } from "sonner";
import { authClient } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { hasOwner } from "@/lib/files/api.functions";
import { usernameToEmail } from "@/lib/files/identity";
import { pageAfterSignIn, readStoredNext } from "@/lib/host-page.mjs";
import { APP_VERSION } from "@/lib/version";

export const Route = createFileRoute("/login")({ ssr: false, component: LoginPage });

function LoginPage() {
  const navigate = useNavigate();
  const { user, isPending } = useCurrentUserState();
  const [ready, setReady] = useState(false);
  const [owned, setOwned] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);

  useEffect(() => {
    if (!isPending && user) {
      void navigate({ to: pageAfterSignIn(window.location.hostname, readStoredNext()) });
    }
  }, [isPending, user, navigate]);

  useEffect(() => {
    let alive = true;
    hasOwner()
      .then((value) => {
        if (!alive) return;
        setOwned(value.owned);
        if (value.owned && value.username) setUsername(value.username);
      })
      .catch(() => {
        if (alive) setOwned(false);
      })
      .finally(() => {
        if (alive) setReady(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const name = username.trim();
    if (!name || !password) {
      toast.error("Enter a username and password");
      return;
    }
    if (!owned) {
      if (password.length < 8) {
        toast.error("Use at least 8 characters");
        return;
      }
      if (password !== confirm) {
        toast.error("Passwords do not match");
        return;
      }
    }

    setBusy(true);
    try {
      const email = usernameToEmail(name);
      if (!owned) {
        const { error } = await authClient.signUp.email({
          email,
          password,
          name,
        });
        if (error) throw new Error(error.message ?? "Could not create lock");
      } else {
        const { error } = await authClient.signIn.email({ email, password });
        if (error) throw new Error(error.message ?? "Wrong username or password");
      }
      await navigate({ to: pageAfterSignIn(window.location.hostname, readStoredNext()) });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not continue");
    } finally {
      setBusy(false);
    }
  }

  if (isPending || !ready) {
    return (
      <main className="grid min-h-dvh place-items-center bg-bg px-6">
        <div className="h-10 w-40 animate-pulse rounded-sm bg-bg-subtle" />
      </main>
    );
  }

  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden bg-bg px-5 py-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            "linear-gradient(to right, rgb(241 241 243 / 0.04) 1px, transparent 1px), linear-gradient(to bottom, rgb(241 241 243 / 0.04) 1px, transparent 1px)",
          backgroundSize: "48px 48px",
          maskImage: "radial-gradient(ellipse at center, black 20%, transparent 72%)",
        }}
      />
      <section className="relative w-full max-w-[22rem] rounded-xl border border-border bg-bg-elevated p-6 shadow-[var(--shadow-border)]">
        <div className="mb-6 flex items-start gap-3">
          <span className="grid size-10 place-items-center rounded-md bg-bg-subtle text-fg">
            <HardDrive className="size-5" strokeWidth={1.6} />
          </span>
          <div>
            <p className="font-mono text-[11px] tracking-[0.18em] text-fg-subtle uppercase">
              Drivebay
            </p>
            <h1 className="mt-0.5 text-xl font-medium tracking-tight">
              {owned ? "Unlock this machine" : "Set the lock"}
            </h1>
          </div>
        </div>
        <p className="mb-5 text-sm leading-relaxed text-fg-muted">
          {owned
            ? "Sign in with the username and password you created. This is the only gate to your drives."
            : "Create the only account on this browser. After this, nobody else can sign up."}
        </p>
        <form className="space-y-3.5" onSubmit={(e) => void onSubmit(e)}>
          <div className="space-y-1.5">
            <Label htmlFor="username">Username</Label>
            <Input
              id="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete={owned ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {!owned && (
            <div className="space-y-1.5">
              <Label htmlFor="confirm">Confirm password</Label>
              <Input
                id="confirm"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
          )}
          <Button type="submit" className="mt-2 w-full" disabled={busy}>
            {busy ? "Working…" : owned ? "Unlock" : "Create lock"}
          </Button>
        </form>
        {owned && (
          <div className="mt-4 text-sm leading-relaxed text-fg-muted">
            <button
              type="button"
              className="underline decoration-fg-subtle underline-offset-2"
              onClick={() => setForgot((open) => !open)}
            >
              Forgot password?
            </button>
            {forgot && (
              <p className="mt-2">
                A password can only be reset on this PC. Right-click the Drivebay icon in the
                notification area and choose Reset password. Type the new password twice. It cannot
                be reset from a phone, a browser, or another computer.
              </p>
            )}
          </div>
        )}
        <p className="mt-4 text-center font-mono text-[10px] tracking-wide text-fg-subtle">{APP_VERSION}</p>
      </section>
    </main>
  );
}
