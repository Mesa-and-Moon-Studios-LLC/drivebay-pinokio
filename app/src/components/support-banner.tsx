import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { DONATE_KOFI_URL, DONATE_PAYPAL_URL } from "@/lib/donate.mjs";

const DISMISS_KEY = "drivebay.supportBanner.dismissed";
const CHANGED = "drivebay-support-banner";

export function supportBannerDismissed() {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function setSupportBannerDismissed(dismissed: boolean) {
  try {
    if (dismissed) window.localStorage.setItem(DISMISS_KEY, "1");
    else window.localStorage.removeItem(DISMISS_KEY);
  } catch {
    // Private mode can refuse storage. The banner stays for this page view.
  }
  window.dispatchEvent(new Event(CHANGED));
}

/** Watches the saved dismissal so the banner and the Donate menu stay in step. */
export function useSupportBannerDismissed() {
  const [dismissed, setDismissed] = useState(true);
  useEffect(() => {
    const sync = () => setDismissed(supportBannerDismissed());
    sync();
    window.addEventListener(CHANGED, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(CHANGED, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return dismissed;
}

/** Slim, dismissable "Support Drivebay" strip. Hidden for good once closed (Settings > Support brings it back). */
export function SupportBanner() {
  const dismissed = useSupportBannerDismissed();
  const links = [
    { label: "Ko-fi", url: DONATE_KOFI_URL },
    { label: "PayPal", url: DONATE_PAYPAL_URL },
  ].filter((link) => link.url && link.url.trim() !== "");
  if (dismissed || links.length === 0) return null;
  return (
    <div
      role="region"
      aria-label="Support Drivebay"
      className="flex shrink-0 items-center gap-2 border-b border-border bg-bg-elevated px-3 py-1.5 text-xs text-fg-muted md:px-4"
    >
      <span className="min-w-0 flex-1 truncate">Enjoying Drivebay? It&apos;s free, and a tip helps keep it going.</span>
      {links.map((link) => (
        <a
          key={link.label}
          href={link.url}
          target="_blank"
          rel="noopener"
          className="shrink-0 rounded-sm border border-border px-2 py-0.5 text-fg hover:bg-bg-subtle"
        >
          {link.label}
        </a>
      ))}
      <button
        type="button"
        aria-label="Hide support banner"
        className="shrink-0 rounded-sm p-1 text-fg-subtle hover:bg-bg-subtle hover:text-fg"
        onClick={() => setSupportBannerDismissed(true)}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
