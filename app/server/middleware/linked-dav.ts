/**
 * WebDAV and machine pairing. These requests are not the file-browser session.
 * Another Drivebay machine calls them directly.
 */
import { handleLinkedHttp } from "../../src/lib/files/linked-http.mjs";
import { machineHome } from "../../src/lib/files/linked-store.mjs";
import { resolveDataDir } from "../../src/lib/files/settings.server";

type LinkedEvent = {
  url: URL;
  req: Request;
  context?: { clientAddress?: string };
  node?: { req?: { socket?: { remoteAddress?: string | null } } };
};

function remoteAddress(event: LinkedEvent): string {
  const socket = event.node?.req?.socket?.remoteAddress;
  if (socket) return socket;
  if (event.context?.clientAddress) return event.context.clientAddress;
  return "";
}

export default async function linkedDavMiddleware(event: LinkedEvent, next: () => Promise<unknown>) {
  const path = event.url.pathname;
  if (path !== "/dav" && !path.startsWith("/dav/") && !path.startsWith("/api/link/")) return next();
  const method = (event.req.method || "GET").toUpperCase();
  let body: Uint8Array = new Uint8Array();
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    try {
      body = new Uint8Array(await event.req.arrayBuffer());
    } catch {
      body = new Uint8Array();
    }
  }
  const headers: Record<string, string> = {};
  event.req.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const result = await handleLinkedHttp({
    method,
    path,
    headers,
    body: Buffer.from(body),
    remoteAddress: remoteAddress(event),
    home: machineHome() || resolveDataDir(),
  });
  if (!result) return next();
  const raw = result.body;
  const bytes = raw instanceof Uint8Array ? new Uint8Array(raw) : new TextEncoder().encode(String(raw ?? ""));
  return new Response(bytes, { status: result.status, headers: result.headers });
}
