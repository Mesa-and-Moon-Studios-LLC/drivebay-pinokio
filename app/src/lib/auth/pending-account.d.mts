export const PENDING_ACCOUNT_FILE: string;

export function pendingAccountPath(
  env?: NodeJS.ProcessEnv,
  pathApi?: typeof import("node:path"),
): string;

export function parsePendingAccount(
  text: string,
):
  | { ok: true; username: string; password: string }
  | { ok: false; reason: string };

export function loadPendingAccount(
  file: string,
  fsApi?: Pick<typeof import("node:fs"), "existsSync" | "readFileSync">,
):
  | { ok: true; username: string; password: string }
  | { ok: false; reason: string }
  | null;

export function firstRunMode(state: {
  userCount: number;
  pending: { ok: boolean } | null;
}): "unlock" | "create";

export function shredFile(file: string): void;
