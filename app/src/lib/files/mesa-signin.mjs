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
