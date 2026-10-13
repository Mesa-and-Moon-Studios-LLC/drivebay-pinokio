import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import {
  homeLocation,
  isSpaDocument,
  redirectResponse,
  replacementForDocumentError,
} from "@/lib/files/document-request.mjs";

/**
 * Nitro's static handler runs before this file. A browser that asks for a
 * script, stylesheet, or other built file never reaches the checks below.
 * Document requests are answered with HTML or a redirect here, before a
 * signed-out session can turn the page into JSON. `/api/*`, `/_serverFn/*`,
 * and `Accept: application/json` keep JSON. Server-lock writes stay on the
 * server functions, which still require a loopback socket and a session.
 */
const documentMiddleware = createMiddleware().server(async ({ next, request, pathname, handlerType }) => {
  if (handlerType === "serverFn") return next();

  const accept = request.headers.get("accept");
  if (!isSpaDocument(pathname, accept, request.method)) return next();

  if (pathname === "/" || pathname === "") {
    const dest = await loopbackHome(request);
    if (dest) return redirectResponse(request.url, dest);
  }

  try {
    const result = await next();
    const response = result instanceof Response ? result : result?.response;
    if (!(response instanceof Response)) return result;
    const replacement = await replacementFor(request.url, pathname, response);
    return replacement ?? result;
  } catch (err) {
    if (isAbort(err)) throw err;
    return fallbackDocument(request.url, pathname);
  }
});

const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

export const startInstance = createStart(() => ({
  requestMiddleware: [documentMiddleware, csrfMiddleware],
}));

async function loopbackHome(request: Request): Promise<"/settings" | "/login" | null> {
  let hostname = "";
  try {
    hostname = new URL(request.url).hostname;
  } catch {
    return null;
  }
  if (homeLocation("/", hostname, true) == null) return null;

  let hasSession = false;
  try {
    const verify = await import("@/lib/auth/verify.server");
    if (!verify.authConfigured) {
      hasSession = true;
    } else {
      hasSession = Boolean(await verify.getSessionUser());
    }
  } catch {
    hasSession = false;
  }
  return homeLocation("/", hostname, hasSession);
}

async function replacementFor(requestUrl: string, pathname: string, response: Response) {
  let bodyText: string | null = null;
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("application/json") && response.status < 400) {
    bodyText = await peekText(response, 2048);
  }
  return replacementForDocumentError(requestUrl, pathname, response.status, type, bodyText);
}

function fallbackDocument(requestUrl: string, pathname: string) {
  return (
    replacementForDocumentError(requestUrl, pathname, 401, "application/json", '{"error":"Unauthorized"}') ??
    redirectResponse(requestUrl, "/login")
  );
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

async function peekText(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.clone().body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const step = await reader.read();
      if (step.done) break;
      if (!step.value) continue;
      chunks.push(step.value);
      size += step.value.byteLength;
    }
  } catch {
    return "";
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
  const buf = new Uint8Array(Math.min(size, limit));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, buf.length - offset);
    if (take <= 0) break;
    buf.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  return new TextDecoder().decode(buf);
}
