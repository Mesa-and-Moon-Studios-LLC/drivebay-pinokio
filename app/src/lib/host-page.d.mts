export const AFTER_LOGIN_KEY: string;

export function pageAfterSignIn(
  hostname: string,
  storedNext?: string | null,
): "/settings" | "/";

export function rememberSettingsAfterLogin(): void;
export function readStoredNext(): string | null;
export function clearStoredNext(): void;
