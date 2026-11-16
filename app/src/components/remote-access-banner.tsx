import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatCountdown, REMOTE_ACCESS_BANNER } from "@/lib/files/linked-copy.mjs";
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
      className="flex flex-wrap items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-fg"
      data-testid="remote-access-banner"
      role="status"
    >
      <p className="min-w-0 flex-1">
        Remote access is on
        {remaining != null ? ` · turns off in ${formatCountdown(remaining)}` : ""}
        {` · ${mode}`}
        {access.byName ? ` · turned on by ${access.byName}` : ""}. {REMOTE_ACCESS_BANNER}
      </p>
      {canEdit ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            void setMachineRemoteAccess({ data: { machineId, enabled: false } }).then(() => onChange?.());
          }}
        >
          Turn off
        </Button>
      ) : null}
    </div>
  );
}
