import { createFileRoute } from "@tanstack/react-router";
import { APP_VERSION } from "@/lib/version";
import {
  CHECK_INTERVAL_MS,
  checkDesktopUpdate,
  platformId,
  writeUpdateStatus,
} from "@/lib/files/update-policy.mjs";

type StatusBody = {
  action?: string;
  reason?: string;
  latest?: string;
  minimum?: string;
  message?: string;
  url?: string;
  version?: string;
  platform?: string;
  fileName?: string;
  downloadUrl?: string;
  checkedAt?: number;
};

let cache: { at: number; body: StatusBody } | null = null;

function ttl(body: StatusBody): number {
  if (body.reason === "unavailable") return 60_000;
  return CHECK_INTERVAL_MS;
}

async function loadStatus(force: boolean): Promise<StatusBody> {
  const versionText = `Drivebay ${APP_VERSION}`;
  const home = process.env.DRIVEBAY_HOME;
  const platform = platformId();
  const body = home
    ? await writeUpdateStatus(home, versionText, { force, platform })
    : await checkDesktopUpdate(versionText, { force, platform });
  return { ...body, version: body.version || APP_VERSION };
}

export const Route = createFileRoute("/api/update-status")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const force = new URL(request.url).searchParams.get("force") === "1";
        const now = Date.now();
        if (!force && cache && now - cache.at < ttl(cache.body)) {
          return Response.json(cache.body);
        }
        const body = await loadStatus(force);
        cache = { at: now, body };
        return Response.json(body);
      },
    },
  },
});
