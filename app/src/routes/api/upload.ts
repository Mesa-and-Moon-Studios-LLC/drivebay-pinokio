import { createFileRoute } from "@tanstack/react-router";
import { authConfigured, DEV_USER_ID, getSessionUser } from "@/lib/auth/verify.server";
import { planRawUpload } from "@/lib/files/raw-upload.mjs";

async function handleUpload(request: Request): Promise<Response> {
  const user = await getSessionUser();
  if (authConfigured && !user) return new Response("Unauthorized", { status: 401 });
  if (!authConfigured && !user && !DEV_USER_ID) return new Response("Unauthorized", { status: 401 });

  const url = new URL(request.url);
  const parent = url.searchParams.get("parent") || "";
  const name = url.searchParams.get("name") || "";
  const lock = await import("@/lib/files/server-lock.server");
  const policy = lock.readServerLock();
  const maxBytes = policy.maxUploadMb * 1024 * 1024;
  const declared = Number(request.headers.get("content-length"));
  const early = planRawUpload({
    parent,
    name,
    length: Number.isFinite(declared) ? declared : 1,
    maxBytes,
    allowUpload: policy.allowUpload,
  });
  if (!early.ok) return new Response(early.error, { status: early.status });

  const remote = await import("@/lib/files/remote-actions.server");
  remote.assertRemoteAction("upload");

  const bytes = new Uint8Array(await request.arrayBuffer());
  const planned = planRawUpload({
    parent,
    name,
    length: bytes.length,
    maxBytes,
    allowUpload: policy.allowUpload,
  });
  if (!planned.ok) return new Response(planned.error, { status: planned.status });

  const fs = await import("@/lib/files/fs.server");
  const access = await import("@/lib/files/drive-access.server");
  const resolved = fs.resolveSafePath(parent);
  lock.assertPathAllowed(resolved);
  await access.assertPathAllowedByDriveAccess(resolved);
  lock.assertUploadSize(bytes.length);
  const saved = await fs.writeUpload(parent, planned.name, bytes);
  return Response.json({ ok: true, path: saved, size: bytes.length });
}

export const Route = createFileRoute("/api/upload")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          return await handleUpload(request);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Upload failed";
          const status = typeof err === "object" && err && "status" in err && typeof err.status === "number" ? err.status : message === "Unauthorized" ? 401 : 400;
          return new Response(message, { status });
        }
      },
    },
  },
});
