import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatCountdown, REMOTE_ACCESS_BANNER, REMOTE_ACCESS_BANNER_TITLE } from "@/lib/files/linked-copy.mjs";
import { setMachineRemoteAccess } from "@/lib/files/linked-machines.functions";

export type RemoteAccessInfo = {
  enabled?: boolean;
  offAt?: number | null;
  mode?: string;
  source?: string;
  byName?: string;
};

export function RemoteAccessBanner({
  access,
  machineId = "self",
  canEdit = true,
  onChange,
}: {
  access?: RemoteAccessInfo | null;
  machineId?: string;
  canEdit?: boolean;
  onChange?: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  if (!access?.enabled) return null;
  if (access.offAt && now >= access.offAt) return null;
  const remaining = access.offAt ? access.offAt - now : null;
  const mode = access.mode === "ro" ? "read-only" : "read-and-write";
  return (
    <div
      className="flex flex-wrap items-start gap-2 border-b border-red-500/50 bg-red-600/15 px-3 py-2 text-sm text-fg"
      data-testid="remote-access-banner"
      role="status"
    >
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-medium">
          {REMOTE_ACCESS_BANNER_TITLE}
          {remaining != null ? ` · ${formatCountdown(remaining)} left` : ""}
          {` · ${mode}`}
          {access.byName ? ` · turned on by ${access.byName}` : ""}
        </p>
        <p className="text-xs leading-snug text-fg/90">{REMOTE_ACCESS_BANNER}</p>
      </div>
      {canEdit ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="shrink-0 border-red-500/60"
          onClick={() => {
            void setMachineRemoteAccess({ data: { machineId, enabled: false } }).then(() => onChange?.());
          }}
        >
          Off now
        </Button>
      ) : null}
    </div>
  );
}
