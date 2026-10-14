/**
 * better-auth 1.7 removed `genericOAuthClient` from `better-auth/client/plugins`.
 * Generic OAuth now uses the core social sign-in endpoints, so the client plugin
 * is a no-op. Email/password sign-in does not use it.
 */
export function genericOAuthClient() {
  return {
    id: "generic-oauth",
  };
}
