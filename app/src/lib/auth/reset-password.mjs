/**
 * Local password reset for the one Drivebay account.
 * This updates the Better Auth credential hash and deletes sessions.
 * It does not change settings, drives, or API tokens, and it has no HTTP route.
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const SCRYPT = { N: 16384, r: 16, p: 1, dkLen: 64 };

export const MIN_PASSWORD_LENGTH = 8;

function scryptKey(password, salt) {
  return new Promise((resolve, reject) => {
    scrypt(
      String(password).normalize("NFKC"),
      salt,
      SCRYPT.dkLen,
      {
        N: SCRYPT.N,
        r: SCRYPT.r,
        p: SCRYPT.p,
        maxmem: 128 * SCRYPT.N * SCRYPT.r * 2,
      },
      (err, key) => {
        if (err) reject(err);
        else resolve(key);
      },
    );
  });
}

/** Same salt:hex format as @better-auth/utils password hashing on Node. */
export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const key = await scryptKey(password, salt);
  return `${salt}:${key.toString("hex")}`;
}

export async function verifyPassword(hash, password) {
  const [salt, key] = String(hash ?? "").split(":");
  if (!salt || !key) return false;
  const target = await scryptKey(password, salt);
  const left = Buffer.from(key, "utf8");
  const right = Buffer.from(target.toString("hex"), "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function checkNewPassword(password) {
  const value = String(password ?? "");
  if (value.length < MIN_PASSWORD_LENGTH) return { ok: false, reason: "Use at least 8 characters." };
  if (value.length > 256) return { ok: false, reason: "Use at most 256 characters." };
  if (value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    return { ok: false, reason: "The password must be a single line." };
  }
  return { ok: true, password: value };
}

export function samePassword(left, right) {
  const a = Buffer.from(String(left ?? ""), "utf8");
  const b = Buffer.from(String(right ?? ""), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * @param {{ query: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]> }} sql
 * @param {string} password
 */
export async function resetCredentialPassword(sql, password) {
  const checked = checkNewPassword(password);
  if (!checked.ok) return checked;
  const accounts = await sql.query(
    `select a."id" as id, a."userId" as "userId", u."name" as name, u."email" as email
     from "account" a
     join "user" u on u."id" = a."userId"
     where a."providerId" = 'credential'`,
  );
  if (!accounts.length) return { ok: false, reason: "No Drivebay account is saved on this PC." };
  const hash = await hashPassword(checked.password);
  const userIds = [];
  for (const account of accounts) {
    const id = String(account.id ?? "");
    const userId = String(account.userId ?? "");
    if (!id || !userId) continue;
    await sql.query(
      `update "account" set "password" = $1, "updatedAt" = now() where "id" = $2 and "providerId" = 'credential'`,
      [hash, id],
    );
    if (!userIds.includes(userId)) userIds.push(userId);
  }
  if (!userIds.length) return { ok: false, reason: "No Drivebay account is saved on this PC." };
  for (const userId of userIds) {
    await sql.query(`delete from "session" where "userId" = $1`, [userId]);
    const email = accounts.find((row) => String(row.userId) === userId)?.email;
    if (email) await sql.query(`delete from "verification" where "identifier" = $1`, [String(email)]);
  }
  const first = accounts[0];
  const username = String(first.name || first.email || "owner");
  return { ok: true, username, userIds, accounts: accounts.length };
}

export function publicResetResult(result) {
  return {
    ok: Boolean(result?.ok),
    username: result?.ok ? String(result.username ?? "") : "",
    reason: result?.ok ? "" : String(result?.reason || "Password reset failed."),
  };
}

/** One line from stdin. The password is not written back out. */
export async function readStdinPassword(stdin) {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  const line = text.split(/\r?\n/, 1)[0] ?? "";
  return line;
}
