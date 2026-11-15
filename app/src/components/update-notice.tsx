import { useEffect, useState } from "react";

type UpdateStatus = {
  action?: string;
  message?: string;
  url?: string;
  latest?: string;
  version?: string;
  reason?: string;
  downloadUrl?: string;
};

const DISMISS_KEY = "drivebay-update-dismissed";
const STATUS_EVENT = "drivebay-update-status";

/** Required updates block the page. Optional updates are a banner. Offline checks do nothing. */
export function UpdateNotice() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [hidden, setHidden] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancel = false;
    const apply = (body: UpdateStatus | null) => {
      if (!cancel) setStatus(body);
    };
    fetch("/api/update-status")
      .then((res) => (res.ok ? res.json() : null))
      .then((body: UpdateStatus | null) => apply(body))
      .catch(() => {
        /* Fail open when the status route cannot be read. */
      });
    const onStatus = (event: Event) => {
      const body = (event as CustomEvent<UpdateStatus>).detail;
      if (body) {
        setHidden(false);
        setStatus(body);
      }
    };
    window.addEventListener(STATUS_EVENT, onStatus);
    return () => {
      cancel = true;
      window.removeEventListener(STATUS_EVENT, onStatus);
    };
  }, []);

  if (!status || status.action === "none" || !status.action) return null;
  const href = status.url || "https://github.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/releases/latest";
  const canApply = Boolean(status.downloadUrl);

  async function install() {
    if (!canApply) {
      window.open(href, "_blank", "noopener");
      return;
    }
    setBusy(true);
    setNote("");
    try {
      const res = await fetch("/api/update-apply", { method: "POST" });
      const body = (await res.json().catch(() => null)) as { started?: boolean; reason?: string } | null;
      if (res.status === 403) {
        setNote("Open Drivebay on this PC to install the update.");
        return;
      }
      if (body?.started) {
        setNote("Downloading the update. Drivebay will restart when it finishes.");
        return;
      }
      window.open(href, "_blank", "noopener");
    } catch {
      window.open(href, "_blank", "noopener");
    } finally {
      setBusy(false);
    }
  }

  const updateControl = canApply ? (
    <button
      type="button"
      className="underline disabled:opacity-60"
      disabled={busy}
      onClick={() => void install()}
    >
      Update
    </button>
  ) : (
    <a className="underline" href={href} target="_blank" rel="noreferrer">
      Update
    </a>
  );

  if (status.action === "optional") {
    const dismissed = typeof sessionStorage !== "undefined" && sessionStorage.getItem(DISMISS_KEY) === status.latest;
    if (hidden || dismissed) return null;
    return (
      <div className="fixed top-0 right-0 left-0 z-[80] flex items-center gap-3 border-b border-border bg-bg-elevated px-4 py-2 text-sm">
        <span className="min-w-0 flex-1">
          Update available. Drivebay {status.latest} is ready to install.
          {note ? ` ${note}` : ""}
        </span>
        {updateControl}
        <button
          type="button"
          className="text-fg-muted"
          onClick={() => {
            if (status.latest) sessionStorage.setItem(DISMISS_KEY, status.latest);
            setHidden(true);
          }}
        >
          Close
        </button>
      </div>
    );
  }
  if (status.action !== "required") return null;
  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-[#0F1218] px-6 py-10 text-center text-[#E8EEF7]">
      <div className="max-w-md space-y-4">
        <h1 className="text-2xl font-semibold">Update required</h1>
        <p className="text-sm text-[#CBD5E1]">
          {status.message || "This version of Drivebay is out of date. Install the latest release to keep using it."}
        </p>
        <p className="font-mono text-xs text-[#94A3B8]">
          Running {status.version}. Required release {status.latest}.
        </p>
        {canApply ? (
          <button
            type="button"
            className="inline-flex rounded-md bg-[#F2C94C] px-4 py-2 text-sm font-medium text-[#0F1218] disabled:opacity-60"
            disabled={busy}
            onClick={() => void install()}
          >
            Update
          </button>
        ) : (
          <a
            className="inline-flex rounded-md bg-[#F2C94C] px-4 py-2 text-sm font-medium text-[#0F1218]"
            href={href}
            target="_blank"
            rel="noreferrer"
          >
            Download the update
          </a>
        )}
        {note ? <p className="text-sm text-[#CBD5E1]">{note}</p> : null}
      </div>
    </div>
  );
}

export const UPDATE_STATUS_EVENT = STATUS_EVENT;
