/** Where this PC should land after install, start, or sign-in. */
export const AFTER_LOGIN_KEY = "drivebay-after-login";

/**
 * Loopback is this PC. Other hostnames are phones and other computers,
 * which still open the file browser.
 * @param {string} hostname
 * @param {string | null | undefined} storedNext
 * @returns {"/settings" | "/"}
 */
export function pageAfterSignIn(hostname, storedNext) {
  const host = String(hostname ?? "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return "/settings";
  if (storedNext === "/settings") return "/settings";
  return "/";
}

export function rememberSettingsAfterLogin() {
  try {
    sessionStorage.setItem(AFTER_LOGIN_KEY, "/settings");
  } catch {
    /* private mode */
  }
}

export function readStoredNext() {
  try {
    return sessionStorage.getItem(AFTER_LOGIN_KEY);
  } catch {
    return null;
  }
}

export function clearStoredNext() {
  try {
    sessionStorage.removeItem(AFTER_LOGIN_KEY);
  } catch {
    /* ignore */
  }
}
