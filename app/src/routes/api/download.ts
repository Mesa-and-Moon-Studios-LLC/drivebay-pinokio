import { createFileRoute } from "@tanstack/react-router";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { basename } from "node:path";
import { getSessionUser, authConfigured, DEV_USER_ID } from "@/lib/auth/verify.server";
import * as fsUtil from "@/lib/files/fs.server";
import { planDownload, responseHeaders } from "@/lib/files/byte-range.mjs";

function contentDisposition(filename: string): string {
  // RFC 5987 filename* for non-ASCII; basic filename fallback.
  const safe = filename.replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()]/g, escape);
  return `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`;
}

async function handleDownload(request: Request): Promise<Response> {
  const user = await getSessionUser();
  if (authConfigured && !user) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!authConfigured && !user && !DEV_USER_ID) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(request.url);
  const filePath = url.searchParams.get("path");
  if (!filePath) {
    return new Response("Missing path", { status: 400 });
  }

  const resolved = fsUtil.resolveSafePath(filePath);
  const lock = await import("@/lib/files/server-lock.server");
  const access = await import("@/lib/files/drive-access.server");
  lock.assertPathAllowed(resolved);
  await access.assertPathAllowedByDriveAccess(resolved);
  const st = await stat(resolved);
  if (!st.isFile()) {
    return new Response("Not a file", { status: 400 });
  }

  const name = basename(resolved);
  const ext = fsUtil.extOf(name);
  const mime = fsUtil.mimeOf(ext);
  const plan = planDownload({
    size: st.size,
    mtimeMs: st.mtimeMs,
    rangeHeader: request.headers.get("range"),
    ifRangeHeader: request.headers.get("if-range"),
    method: request.method,
  });
  const headers = responseHeaders(plan, {
    contentType: mime,
    contentDisposition: contentDisposition(name),
  });

  if (plan.kind === "unsatisfiable" || plan.head || plan.length === 0) {
    return new Response(null, { status: plan.status, headers });
  }

  const nodeStream = createReadStream(resolved, { start: plan.start, end: plan.end });
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;
  return new Response(webStream, { status: plan.status, headers });
}

export const Route = createFileRoute("/api/download")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          return await handleDownload(request);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Download failed";
          const status = message === "Unauthorized" ? 401 : 400;
          return new Response(message, { status });
        }
      },
      HEAD: async ({ request }) => {
        try {
          return await handleDownload(request);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Download failed";
          const status = message === "Unauthorized" ? 401 : 400;
          return new Response(null, { status });
        }
      },
    },
  },
});
