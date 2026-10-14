import { resolve } from "node:path";
import { handleTokenApi } from "./api-v1.mjs";
import { listEnabledDrives } from "./drive-access.server";
import { isPathAllowedByRoots, readServerLock } from "./server-lock.server";
import { resolveDataDir } from "./settings.server";

export function resolveApiAccessFile(): string {
  return resolve(resolveDataDir(), "api-access.json");
}

export function handleApiV1(request: Request): Promise<Response> {
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
    ratePerMinute: ratePerMinute(),
  });
}

function ratePerMinute(): number {
  const raw = Number(process.env.DRIVEBAY_API_RATE_PER_MINUTE || 60);
  if (!Number.isFinite(raw) || raw < 1) return 60;
  return Math.trunc(raw);
}
