import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { type Db, rows, transaction } from "./db.ts";
import { getSecret } from "./settings.ts";

// Console sign-in. The password comes from
// CONSOLE_PASSWORD and must be at least 16 characters, or the console stays
// off. A session is a signed cookie. Failed attempts are counted in the
// database, so throttling survives instance replacement: after 5 failures in
// 15 minutes, each further try waits longer, up to 15 minutes, for everyone.

export const COOKIE = "session";
const SESSION_DAYS = 30;
const MIN_LENGTH = 16;

export function consoleState(): { enabled: boolean; reason?: string } {
  const password = process.env.CONSOLE_PASSWORD ?? "";
  if (!password) return { enabled: false, reason: "Set CONSOLE_PASSWORD (at least 16 characters) in the project's environment variables, then redeploy." };
  if (password.length < MIN_LENGTH) return { enabled: false, reason: `CONSOLE_PASSWORD must be at least ${MIN_LENGTH} characters. Change it in the project's environment variables, then redeploy.` };
  return { enabled: true };
}

const sha256 = (s: string) => createHash("sha256").update(s).digest();

/** The cookie key changes with the password, so changing it signs everyone out. */
async function sessionKey(db: Db): Promise<string> {
  return `${await getSecret(db, "session_secret")}:${sha256(process.env.CONSOLE_PASSWORD ?? "").toString("hex")}`;
}

export async function makeSession(db: Db): Promise<{ value: string; maxAge: number }> {
  const expires = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86_400;
  const sig = createHmac("sha256", await sessionKey(db)).update(`v1.${expires}`).digest("hex");
  return { value: `v1.${expires}.${sig}`, maxAge: SESSION_DAYS * 86_400 };
}

export async function checkSession(db: Db, value: string | undefined): Promise<boolean> {
  if (!value || !consoleState().enabled) return false;
  const [version, expires, sig] = value.split(".");
  if (version !== "v1" || !sig || Number(expires) < Date.now() / 1000) return false;
  const expected = Buffer.from(createHmac("sha256", await sessionKey(db)).update(`v1.${expires}`).digest("hex"));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Seconds to wait before another attempt, from failures since the last success in the past 15 minutes. */
export function throttleDelay(failures: number): number {
  return failures < 5 ? 0 : Math.min(900, 5 * 2 ** (failures - 5));
}

export async function attemptLogin(db: Db, password: string): Promise<{ ok: true } | { ok: false; retryAfter?: number }> {
  // One attempt at a time, across instances, so a burst of guesses can't all
  // pass the same count.
  return transaction(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('console-login'))`);
    const [row] = await rows<{ failures: number; since_last: number | null }>(
      tx,
      sql`
      with recent as (select ok, at from login_attempts where at > now() - interval '15 minutes'),
           last_ok as (select max(at) as at from recent where ok)
      select count(*) filter (where not ok and at > coalesce((select at from last_ok), '-infinity'))::int as failures,
             extract(epoch from now() - max(at) filter (where not ok))::float8 as since_last
      from recent`,
    );
    const wait = throttleDelay(row.failures);
    if (wait > 0 && (row.since_last ?? Infinity) < wait) return { ok: false, retryAfter: Math.ceil(wait - (row.since_last ?? 0)) };

    const ok = timingSafeEqual(sha256(password), sha256(process.env.CONSOLE_PASSWORD ?? ""));
    await tx.execute(sql`insert into login_attempts (ok) values (${ok})`);
    await tx.execute(sql`delete from login_attempts where at < now() - interval '1 day'`);
    return ok ? ({ ok: true } as const) : ({ ok: false } as const);
  });
}
