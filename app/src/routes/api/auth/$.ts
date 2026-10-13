import { createFileRoute } from "@tanstack/react-router";
import { auth } from "@/lib/auth/server";
import { getSql } from "@/lib/db";

async function ownerExists() {
  const sql = await getSql();
  const rows = await sql<{ n: number }>`select count(*)::int as n from "user"`;
  return (rows[0]?.n ?? 0) > 0;
}

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => auth.handler(request),
      POST: async ({ request }) => {
        const { applyPendingAccount } = await import("@/lib/auth/pending-account.server");
        await applyPendingAccount();
        const url = new URL(request.url);
        const path = url.pathname.toLowerCase();
        if (path.includes("sign-up") && (await ownerExists())) {
          return Response.json({ message: "Sign-up is closed" }, { status: 403 });
        }
        return auth.handler(request);
      },
    },
  },
});
