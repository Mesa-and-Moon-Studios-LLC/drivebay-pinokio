import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useState, type ComponentType } from "react";
import { pageAfterSignIn } from "@/lib/host-page.mjs";
import { SupportBanner } from "@/components/support-banner";
import { RemoteAccessBanner, type RemoteAccessInfo } from "@/components/remote-access-banner";
import { getRouterHelp } from "@/lib/files/api.functions";

export const Route = createFileRoute("/")({
  ssr: false,
  beforeLoad: () => {
    if (typeof window === "undefined") return;
    if (pageAfterSignIn(window.location.hostname, null) === "/settings") {
      throw redirect({ to: "/settings", replace: true });
    }
  },
  component: HomePage,
});

function HomeRemoteBanner() {
  const [access, setAccess] = useState<(RemoteAccessInfo & { canEdit?: boolean }) | null>(null);
  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const help = await getRouterHelp();
        if (alive) setAccess(help.remoteAccess ?? null);
      } catch {
        /* the file browser still works if this status call fails */
      }
    }
    void tick();
    const id = window.setInterval(() => void tick(), 5000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);
  return <RemoteAccessBanner access={access} machineId="self" canEdit={access?.canEdit !== false} onChange={() => void getRouterHelp().then((help) => setAccess(help.remoteAccess ?? null))} />;
}

function HomePage() {
  const [App, setApp] = useState<ComponentType | null>(null);
  useEffect(() => {
    let alive = true;
    void import("@/components/browser/app").then((mod) => {
      if (alive) setApp(() => mod.FileBrowserApp);
    });
    return () => {
      alive = false;
    };
  }, []);
  if (!App) {
    return <div className="min-h-dvh bg-bg" />;
  }
  // One screen-high column: the banner and the file browser share it, so the page itself never
  // scrolls and the browser's top bars stay pinned.
  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden">
      <HomeRemoteBanner />
      <SupportBanner />
      <div className="flex min-h-0 flex-1 flex-col">
        <App />
      </div>
    </div>
  );
}
