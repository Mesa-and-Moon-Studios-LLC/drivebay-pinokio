/** Browser helpers for Mesa and Moon sign-in. No Node APIs. */

export function idpPostBody(providerId, idToken) {
  return `id_token=${encodeURIComponent(idToken)}&providerId=${providerId}`;
}

export function googleAuthorizeUrl({ clientId, redirectUri, nonce }) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "id_token");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("state", `google.${nonce}`);
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export function appleAuthorizeUrl({ clientId, redirectUri, nonce }) {
  const url = new URL("https://appleid.apple.com/auth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "id_token");
  url.searchParams.set("response_mode", "fragment");
  url.searchParams.set("scope", "name email");
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("state", `apple.${nonce}`);
  return url.toString();
}

export function readIdTokenFragment(fragment) {
  const text = String(fragment || "").replace(/^#/, "");
  const params = new URLSearchParams(text);
  const idToken = params.get("id_token") || "";
  const state = params.get("state") || "";
  if (!idToken || !state.includes(".")) return null;
  const [provider, nonce] = state.split(".");
  if (provider !== "google" && provider !== "apple") return null;
  return { idToken, provider, nonce: nonce || "" };
}

/** A loopback Identity Toolkit emulator. Anything else is ignored. */
export function loopbackEmulator(value) {
  const text = String(value || "").trim().replace(/\/$/, "");
  if (!text) return "";
  let url;
  try {
    url = new URL(text);
  } catch {
    return "";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  const host = url.hostname.toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]" && host !== "::1") return "";
  return url.origin;
}

const EMAIL_ACTIONS = {
  signIn: "signInWithPassword",
  signUp: "signUp",
  reset: "sendOobCode",
  lookup: "createAuthUri",
};

export function cleanEmail(value) {
  return String(value || "").trim().toLowerCase();
}

export function passwordOk(value) {
  const text = String(value ?? "");
  return text.length >= 8 && text.length <= 128 && !/[\r\n\0]/.test(text);
}

/** Identity Toolkit URL. The password is posted here and nowhere else. */
export function emailAuthUrl(config, action) {
  const method = EMAIL_ACTIONS[action] || EMAIL_ACTIONS.signIn;
  const key = encodeURIComponent(String(config?.apiKey || ""));
  const emulator = loopbackEmulator(config?.authEmulator);
  const root = emulator ? `${emulator}/identitytoolkit.googleapis.com` : "https://identitytoolkit.googleapis.com";
  return `${root}/v1/accounts:${method}?key=${key}`;
}

export function secureTokenUrl(config) {
  const key = encodeURIComponent(String(config?.apiKey || ""));
  const emulator = loopbackEmulator(config?.authEmulator);
  const root = emulator ? `${emulator}/securetoken.googleapis.com` : "https://securetoken.googleapis.com";
  return `${root}/v1/token?key=${key}`;
}

export function emailAuthBody(action, { email, password, continueUri } = {}) {
  const address = cleanEmail(email);
  if (action === "reset") return { requestType: "PASSWORD_RESET", email: address };
  if (action === "lookup") return { identifier: address, continueUri: continueUri || "http://127.0.0.1" };
  return { email: address, password: String(password ?? ""), returnSecureToken: true };
}

/**
 * Same email on Google or Apple stays that one Firebase user.
 * Drivebay does not attach a password to it from this screen.
 */
export function providerConflictMessage(methods) {
  const list = (methods || []).map((item) => String(item));
  if (list.includes("password") && !list.includes("google.com") && !list.includes("apple.com")) {
    return "That email already has a password. Sign in with it.";
  }
  const names = [];
  if (list.includes("google.com")) names.push("Google");
  if (list.includes("apple.com")) names.push("Apple");
  if (names.length) {
    return `That email already belongs to a Mesa and Moon account signed in with ${names.join(" and ")}. Use that button. Drivebay does not add a password onto that login, so it stays one account.`;
  }
  return "That email already has a Mesa and Moon account. If you signed in with Google or Apple, use that button. Drivebay does not add a password onto that login, so it stays one account.";
}

export function emailAuthError(action, body) {
  const message = String(body?.error?.message || "");
  if (action === "reset") {
    return { code: "reset", message: "If this email can receive mail from Mesa and Moon, a reset link is on its way." };
  }
  if (action === "signUp" && message.includes("EMAIL_EXISTS")) {
    return { code: "exists", message: providerConflictMessage([]) };
  }
  if (message.includes("INVALID_EMAIL")) return { code: "email", message: "Enter the email for this Mesa and Moon account." };
  if (message.includes("WEAK_PASSWORD")) return { code: "password", message: "Use a password of at least 8 characters." };
  return { code: "rejected", message: "That email or password was not accepted." };
}

/** Tokens only. The password is not part of this object. */
export function emailSession(body) {
  const idToken = String(body?.idToken || "");
  const refreshToken = String(body?.refreshToken || "");
  if (!idToken || !refreshToken) return null;
  return {
    idToken,
    refreshToken,
    expiresIn: Number(body.expiresIn) || 3600,
    email: String(body.email || ""),
  };
}
