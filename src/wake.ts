import { createHmac, timingSafeEqual } from "node:crypto";

// The scheduled function (netlify/functions/wake.mts) runs WORK_DUE_SQL every
// minute and calls the server's /internal/wake only when something is due. The
// call is signed with a key that the first migration generates in `settings`,
// so there's no extra environment variable to set.

/** One query: is anything due, and the wake key. Work deferred by `not_before` doesn't count. */
export const WORK_DUE_SQL = `select (
  exists (select 1 from schedules where not paused and next_run_at <= now())
  or exists (
    select 1 from runs r join conversations c on c.id = r.conversation_id
    where r.state in ('queued', 'running') and r.not_before <= now()
      and (c.lease_until is null or c.lease_until < now()))
  or exists (
    select 1 from deliveries
    where (state = 'pending' and next_attempt_at <= now()) or (state = 'sending' and lease_until < now()))
) as due,
(select value #>> '{}' from settings where key = 'wake_secret') as secret`;

export const WAKE_PATH = "/internal/wake";
const MAX_SKEW_SECONDS = 120;

export function signWake(secret: string, timestamp: number): string {
  return createHmac("sha256", secret).update(`wake:${timestamp}`).digest("hex");
}

export function verifyWake(secret: string, timestamp: string | undefined, signature: string | undefined): boolean {
  const ts = Number(timestamp);
  if (!signature || !Number.isInteger(ts) || Math.abs(Date.now() / 1000 - ts) > MAX_SKEW_SECONDS) return false;
  const expected = Buffer.from(signWake(secret, ts));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
