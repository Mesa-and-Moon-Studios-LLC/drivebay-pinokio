import { createFileRoute } from "@tanstack/react-router";
import fs from "node:fs";
import path from "node:path";
import { APP_VERSION } from "@/lib/version";
import { decideUpdate, fetchLatestManifest } from "@/lib/files/update-policy.mjs";

type StatusBody = ReturnType<typeof decideUpdate> & { version: string };

let cache: { at: number; body: StatusBody } | null = null;

function ttl(body: StatusBody): number {
  if (body.reason === "unavailable") return 60_000;
  return 6 * 60 * 60 * 1000;
}

export const Route = createFileRoute("/api/update-status")({
  server: {
    handlers: {
      GET: async () => {
        const now = Date.now();
        if (cache && now - cache.at < ttl(cache.body)) {
          return Response.json(cache.body);
        }
        const manifest = await fetchLatestManifest();
        const body: StatusBody = { ...decideUpdate(APP_VERSION, manifest), version: APP_VERSION };
        cache = { at: now, body };
        const home = process.env.DRIVEBAY_HOME;
        if (home) {
          try {
            fs.mkdirSync(home, { recursive: true });
            fs.writeFileSync(path.join(home, "update-status.json"), JSON.stringify(body));
          } catch {
            /* The tray can check again later. A failed write does not block Drivebay. */
          }
        }
        return Response.json(body);
      },
    },
  },
});
