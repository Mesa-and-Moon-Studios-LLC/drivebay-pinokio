import { createFileRoute } from "@tanstack/react-router";
import { APP_VERSION } from "@/lib/version";

/** Identifies this Drivebay server. No session. Install uses it before saying ready. */
export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => {
        const body = JSON.stringify({ ok: true, name: "Drivebay", version: APP_VERSION });
        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      },
    },
  },
});
