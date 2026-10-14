import { auth } from "@/lib/auth/server";
import { getSql } from "@/lib/db";
import { emailToUsername, usernameToEmail } from "@/lib/files/identity";
import {
  firstRunMode,
  loadPendingAccount,
  pendingAccountPath,
  shredFile,
} from "@/lib/auth/pending-account.mjs";

async function userCount() {
  const sql = await getSql();
  const rows = await sql<{ n: number }>`select count(*)::int as n from "user"`;
  return rows[0]?.n ?? 0;
}

/**
 * Turn the installer's pending-account.json into the one Drivebay user.
 * write-setup.ps1 writes UTF-8 JSON { username, password } in the Drivebay home.
 * A second account is not created. Pinokio leaves this file absent.
 */
async function applyOnce() {
  const file = pendingAccountPath();
  const pending = loadPendingAccount(file);
  if (!pending) return;
  if (!pending.ok) {
    console.error(
      "[drivebay] Setup account was rejected. Username is required and the password must be at least 8 characters.",
    );
    shredFile(file);
    return;
  }
  if ((await userCount()) > 0) {
    shredFile(file);
    console.error("[drivebay] An account already exists. The password from setup was not changed.");
    return;
  }
  try {
    await auth.api.signUpEmail({
      body: {
        name: pending.username,
        email: usernameToEmail(pending.username),
        password: pending.password,
      },
    });
    shredFile(file);
    console.log("[drivebay] Drivebay account created from setup. Sign in with that username and password.");
  } catch (err) {
    if ((await userCount()) > 0) {
      shredFile(file);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error("[drivebay] Could not create the account from setup.", message);
  }
}

let pendingApply: Promise<void> | null = null;

export function applyPendingAccount() {
  if (!pendingApply) {
    pendingApply = applyOnce().finally(() => {
      pendingApply = null;
    });
  }
  return pendingApply;
}

/** Unlock when setup already chose the account. Create only when nothing is saved. */
export async function accountFirstRun(): Promise<{ mode: "unlock" | "create"; username: string }> {
  await applyPendingAccount();
  const sql = await getSql();
  const rows = await sql<{ name: string | null; email: string | null }>`
    select name, email from "user" limit 1
  `;
  const row = rows[0];
  if (row) {
    const username = row.name?.trim() || emailToUsername(row.email);
    return { mode: "unlock", username };
  }
  const pending = loadPendingAccount(pendingAccountPath());
  const mode = firstRunMode({ userCount: 0, pending });
  return {
    mode,
    username: mode === "unlock" && pending?.ok ? pending.username : "",
  };
}
