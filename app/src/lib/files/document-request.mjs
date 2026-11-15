/**
 * Browser navigations and API calls are different requests.
 * Nitro serves static files before the app handler. This module decides what
 * the handler should do with whatever is left: HTML for a page, JSON for an API.
 */
import { pageAfterSignIn } from "../host-page.mjs";

/** @param {string | null | undefined} pathname */
export function normalizePath(pathname) {
  const raw = String(pathname ?? "/").split("?")[0] || "/";
  if (raw.length > 1 && raw.endsWith("/")) return raw.slice(0, -1);
  return raw || "/";
}

/**
 * JSON errors are for API callers.
 * A browser Accept header includes text/html or star-slash-star, so it stays a page.
 * A missing Accept header is a page too.
 * @param {string | null | undefined} pathname
 * @param {string | null | undefined} accept
 */
export function wantsJsonError(pathname, accept) {
  const path = normalizePath(pathname);
  if (
    path === "/api" ||
    path.startsWith("/api/") ||
    path === "/_serverFn" ||
    path.startsWith("/_serverFn/")
  ) {
    return true;
  }
  if (accept == null) return false;
  const header = String(accept).trim().toLowerCase();
  if (!header || !header.includes("application/json")) return false;
  if (/(^|,)\s*text\/html\b/.test(header)) return false;
  if (/(^|,)\s*\*\/\*/.test(header)) return false;
  return true;
}

/** @param {string | null | undefined} pathname */
export function isStaticAssetPath(pathname) {
  const path = normalizePath(pathname).toLowerCase();
  if (path.startsWith("/assets/") || path.startsWith("/__grok/")) return true;
  const leaf = path.slice(path.lastIndexOf("/") + 1);
  return /\.[a-z0-9]+$/i.test(leaf);
}

/**
 * A document the SPA should render: GET or HEAD, not an API path, not a file.
 * @param {string | null | undefined} pathname
 * @param {string | null | undefined} accept
 * @param {string | null | undefined} method
 */
export function isSpaDocument(pathname, accept, method) {
  const verb = String(method || "GET").toUpperCase();
  if (verb !== "GET" && verb !== "HEAD") return false;
  const path = normalizePath(pathname);
  if (path === "/dav" || path.startsWith("/dav/") || path.startsWith("/api/link/")) return false;
  if (wantsJsonError(pathname, accept)) return false;
  if (isStaticAssetPath(pathname)) return false;
  return true;
}

/**
 * This PC's `/` goes to settings when a session exists, and to sign-in otherwise.
 * A Tailscale or LAN hostname stays on `/` so the file UI can show its own sign-in.
 * @param {string | null | undefined} pathname
 * @param {string | null | undefined} hostname
 * @param {boolean} hasSession
 * @returns {"/settings" | "/login" | null}
 */
export function homeLocation(pathname, hostname, hasSession) {
  if (normalizePath(pathname) !== "/") return null;
  if (pageAfterSignIn(hostname ?? "", null) !== "/settings") return null;
  return hasSession ? "/settings" : "/login";
}

/**
 * What to do when a document response is an auth or JSON error.
 * @param {string | null | undefined} pathname
 * @param {number} status
 * @param {string | null | undefined} contentType
 * @param {string | null | undefined} bodyText
 * @returns {"html" | "redirect" | null}
 */
export function documentErrorAction(pathname, status, contentType, bodyText) {
  if (!isSpaDocument(pathname, null, "GET")) return null;
  const code = Number(status);
  if (code >= 300 && code < 400) return null;
  const type = String(contentType ?? "").toLowerCase();
  const json = type.includes("application/json");
  const authStatus = code === 401 || code === 403;
  let errorBody = false;
  if (json && bodyText != null) {
    const text = String(bodyText).trim();
    if (text.startsWith("{") && text.length <= 4000) {
      try {
        const parsed = JSON.parse(text);
        const value =
          parsed && typeof parsed === "object"
            ? (parsed.error ?? parsed.message)
            : undefined;
        if (value === "Unauthorized" || value === "Forbidden" || value === true) {
          errorBody = true;
        }
      } catch {
        errorBody = false;
      }
    }
  }
  if (!authStatus && !(code >= 400 && json) && !errorBody) return null;
  return normalizePath(pathname) === "/login" ? "html" : "redirect";
}

/** @param {string} requestUrl @param {string} pathname */
export function locationFor(requestUrl, pathname) {
  const url = new URL(requestUrl);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** @param {string} requestUrl @param {string} pathname */
export function redirectResponse(requestUrl, pathname) {
  return new Response(null, {
    status: 302,
    headers: {
      location: locationFor(requestUrl, pathname),
      "cache-control": "no-store",
    },
  });
}

export function signInPageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in</title>
</head>
<body>
<main>
<h1>Sign in</h1>
<p>Enter the username and password from Drivebay setup.</p>
</main>
</body>
</html>
`;
}

export function signInHtmlResponse() {
  return new Response(signInPageHtml(), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/** Refusal page for a browser when Public access is off. It has no sign-in form. */
export function publicAccessOffHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Drivebay</title>
</head>
<body>
<main>
<h1>Public access is off</h1>
<p>This address is not on this PC and not on your Tailscale network. Drivebay did not open a sign-in page.</p>
<p>Turn public access on from this PC, or from a device that is signed in over Tailscale.</p>
</main>
</body>
</html>
`;
}

export function publicAccessOffResponse() {
  return new Response(publicAccessOffHtml(), {
    status: 403,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/**
 * Replacement for a document that came back as JSON or an auth error.
 * @param {string} requestUrl
 * @param {string | null | undefined} pathname
 * @param {number} status
 * @param {string | null | undefined} contentType
 * @param {string | null | undefined} bodyText
 */
export function replacementForDocumentError(requestUrl, pathname, status, contentType, bodyText) {
  const action = documentErrorAction(pathname, status, contentType, bodyText);
  if (action === "html") return signInHtmlResponse();
  if (action === "redirect") return redirectResponse(requestUrl, "/login");
  return null;
}
