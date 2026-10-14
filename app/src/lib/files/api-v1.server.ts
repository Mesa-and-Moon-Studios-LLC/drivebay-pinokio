import { resolve } from "node:path";
import { handleTokenApi } from "./api-v1.mjs";
import { listEnabledDrives } from "./drive-access.server";
import { assertRemoteAction, type RemoteActionName } from "./remote-actions.server";
import { assertPolicy, assertUploadSize, isPathAllowedByRoots, readServerLock } from "./server-lock.server";
import { resolveDataDir } from "./settings.server";

const POLICY = {
  upload: "allowUpload",
  mkdir: "allowCreateFolder",
  rename: "allowRename",
  delete: "allowDelete",
} as const;

export function resolveApiAccessFile(): string {
  return resolve(resolveDataDir(), "api-access.json");
}

export function handleApiV1(request: Request): Promise<Response> {
  const policy = readServerLock();
  return handleTokenApi(request, {
    file: resolveApiAccessFile(),
    async roots() {
      let drives = await listEnabledDrives();
      const current = readServerLock();
      if (current.allowedRoots.length) {
        drives = drives.filter((drive) => isPathAllowedByRoots(drive.path, current.allowedRoots));
      }
      return drives.map((drive) => ({ id: drive.id, path: drive.path, label: drive.label }));
    },
    assertWrite(action: string, bytes: number) {
      const flag = POLICY[action as keyof typeof POLICY];
      if (!flag) throw new Error("This action is turned off in Settings on the PC that runs Drivebay.");
      assertPolicy(flag);
      if (action === "upload" || action === "rename" || action === "delete" || action === "move") {
        assertRemoteAction(action as RemoteActionName);
      }
      if (action === "upload") assertUploadSize(bytes);
    },
    maxUploadBytes: policy.maxUploadMb * 1024 * 1024,
    ratePerMinute: ratePerMinute(),
  });
}

function ratePerMinute(): number {
  const raw = Number(process.env.DRIVEBAY_API_RATE_PER_MINUTE || 60);
  if (!Number.isFinite(raw) || raw < 1) return 60;
  return Math.trunc(raw);
}
