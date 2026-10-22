import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useState, type ComponentType } from "react";
import { pageAfterSignIn } from "@/lib/host-page.mjs";
import { SupportBanner } from "@/components/support-banner";

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
  return (
    <>
      <SupportBanner />
      <App />
    </>
  );
}
