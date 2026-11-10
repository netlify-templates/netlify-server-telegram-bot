import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { sql } from "drizzle-orm";
import { type Db, type Queryable, rowCount as count, rows, type Tx, transaction } from "./db.ts";

// The run queue: at-least-once runs on Postgres that survive idle stops, deploys
// and crashes. In short:
// - A drain claims a *conversation*, never a run, so one chat runs one run at a
//   time across instances. It then takes that chat's head run.
// - Each claim gets a fresh token. Every later write (heartbeat, a tool's change,
//   finishing) is conditional on it, so a holder that lost its lease can't write.
// - A crashed run keeps its state and its expired lease; the next claim reclaims
//   it as the head. After MAX attempts it fails with a note to the owner.
// - Replies go out through leased deliveries. An attempt above 1 says it may be
//   a repeat.

export interface Run {
  id: number;
  conversationId: string;
  kind: string;
  origin: string;
  input: any;
  attempt: number;
}

export interface Action {
  seq: number;
  attempt: number;
  kind: string;
  result: any;
}

export interface Claim {
  conversationId: string;
  token: string;
  run: Run;
  /** What earlier attempts of this run already did. */
  priorActions: Action[];
}

export interface NewDelivery {
  channel: string;
  destination: string;
  text: string;
  /** Channel extras, such as buttons. */
  meta?: Record<string, unknown>;
}

export interface Delivery extends NewDelivery {
  id: number;
  attempt: number;
  progress: number;
  claimToken: string;
}

export interface Schedule {
  id: number;
  conversationId: string;
  instruction: string;
  mode: string;
  rule: any;
  nextRunAt: Date;
}

export type Outcome =
  | { status: "done"; text: string; result?: unknown }
  /** Put the run back until `until`, without counting an attempt (the spend cap does this). */
  | { status: "defer"; until: Date; reason?: string };

export interface RunEvent {
  type: string;
  [key: string]: unknown;
}

export interface RunContext {
  claim: Claim;
  /** Aborted when the claim is lost or the instance's shutdown deadline passes. */
  signal: AbortSignal;
  /**
   * Makes a change once per run. The change and its record in `actions` commit
   * together, fenced by the claim. In a retried run, the nth call of a kind
   * returns what the earlier attempt's nth call of that kind returned, without
   * acting again.
   */
  act<T>(kind: string, apply: (tx: Tx) => Promise<T>): Promise<{ result: T; replayed: boolean }>;
  /** Progress for anyone watching the run (the console's stream). */
  emit(event: RunEvent): void;
}

/**
 * Sends one delivery. Calls `markProgress(n)` after each part of a long
 * message. Must pass `signal` to its requests and check it before each part:
 * once it fires, another sender may take the delivery over.
 */
export type Sender = (
  delivery: {
    destination: string;
    text: string;
    meta: Record<string, unknown> | null;
    resend: boolean;
    progress: number;
    id: number;
    signal: AbortSignal;
  },
  markProgress: (partsSent: number) => Promise<void>,
) => Promise<void>;

export interface ScheduledWork {
  /** The run's input, or nothing to skip this occurrence. */
  input?: unknown;
  /** The run's kind, "schedule" unless said otherwise. */
  kind?: string;
  /** A line for the owner instead of (or as well as) a run, such as "skipped: 7 hours late". */
  notice?: NewDelivery & { message: string };
  /** The next time, or null when the schedule is finished. */
  nextRunAt: Date | null;
}

export interface QueueApp {
  execute(run: Run, ctx: RunContext): Promise<Outcome>;
  /** Inside the finishing transaction: store the reply and say where it goes. */
  completed(tx: Tx, run: Run, outcome: Extract<Outcome, { status: "done" }>, actions: Action[]): Promise<NewDelivery[]>;
  /** Inside the failing transaction: store a failure note and say where it goes. */
  failed(tx: Tx, run: Run, reason: string, actions: Action[]): Promise<NewDelivery[]>;
  /** Turns a due schedule into work. Called inside the transaction that claims it. */
  scheduled?(tx: Tx, schedule: Schedule, now: Date): Promise<ScheduledWork>;
  senders: Record<string, Sender>;
}

export interface QueueOptions {
  db: Db;
  app: QueueApp;
  leaseSeconds?: number;
  heartbeatMs?: number;
  maxAttempts?: number;
  deliveryLeaseSeconds?: number;
  log?: (message: string, extra?: unknown) => void;
  /**
   * Asked before each claim, schedule and send. The server answers whether
   * this instance is still the live one, so an instance a new deploy has
   * replaced stops taking work before its SIGTERM arrives.
   */
  mayAcquire?: () => Promise<boolean>;
  /** Called for each run event, after the run's own emit. */
  onEvent?: (run: Run, event: RunEvent) => void;
}

export interface IngestInput {
  channel: string;
  key: string;
  conversationId: string;
  kind: string;
  origin: string;
  input: unknown;
  /** Stored in `messages` in the same transaction, so it's visible and searchable right away. */
  message?: { content: string; meta?: unknown };
}

export interface IngestResult {
  runId: number;
  duplicate: boolean;
  /** Whether the caller should start a drain. */
  drain: boolean;
}

export const RESEND_NOTE = "(resending: you may have received this already)";

export class LostClaimError extends Error {
  constructor(message = "Another holder has this conversation now") {
    super(message);
    this.name = "LostClaimError";
  }
}

export class ShutdownError extends Error {
  constructor() {
    super("The instance is shutting down");
    this.name = "ShutdownError";
  }
}

const json = (value: unknown) => sql`${JSON.stringify(value ?? null)}::jsonb`;

const toRun = (r: Record<string, any>): Run => ({
  id: r.id,
  conversationId: r.conversation_id,
  kind: r.kind,
  origin: r.origin,
  input: r.input,
  attempt: r.attempt,
});

const toDelivery = (r: Record<string, any>): Delivery => ({
  id: r.id,
  channel: r.channel,
  destination: r.destination,
  text: r.text,
  meta: r.meta,
  attempt: r.attempt,
  progress: r.progress,
  claimToken: r.claim_token,
});

export async function insertRun(
  q: Queryable,
  r: { conversationId: string; kind: string; origin: string; input: unknown; notBefore?: Date },
): Promise<number> {
  await q.execute(sql`insert into conversations (id) values (${r.conversationId}) on conflict do nothing`);
  const [row] = await rows(
    q,
    sql`insert into runs (conversation_id, kind, origin, input, not_before)
        values (${r.conversationId}, ${r.kind}, ${r.origin}, ${json(r.input)}, coalesce(${r.notBefore ?? null}::timestamptz, now()))
        returning id`,
  );
  return row.id;
}

export async function insertDeliveries(tx: Tx, runId: number | null, list: NewDelivery[]): Promise<number[]> {
  const ids: number[] = [];
  for (const d of list) {
    const [row] = await rows(
      tx,
      sql`insert into deliveries (run_id, channel, destination, text, meta)
          values (${runId}, ${d.channel}, ${d.destination}, ${d.text}, ${json(d.meta ?? null)}) returning id`,
    );
    ids.push(row.id);
  }
  return ids;
}

const loadActions = (q: Queryable, runId: number) =>
  rows<Action>(q, sql`select seq, attempt, kind, result from actions where run_id = ${runId} order by seq`);

export function createQueue(opts: QueueOptions) {
  const { db, app } = opts;
  const leaseSeconds = opts.leaseSeconds ?? 90;
  const heartbeatMs = opts.heartbeatMs ?? 30_000;
  const maxAttempts = opts.maxAttempts ?? 2;
  const deliveryLeaseSeconds = opts.deliveryLeaseSeconds ?? 60;
  const log = opts.log ?? ((message: string, extra?: unknown) => console.log(message, extra ?? ""));
  const mayAcquire = opts.mayAcquire ?? (async () => true);

  let stopping = false;
  let draining: Promise<void> | null = null;
  let again = false;
  const active = new Map<number, AbortController>();

  /**
   * The app's failure hook, in a savepoint. If it throws (a broken route, say),
   * the run still ends as failed, with a generic note in the conversation, so
   * a bad hook can't keep a run, and the chat behind it, stuck forever.
   */
  async function failedSafely(tx: Tx, run: Run, reason: string): Promise<NewDelivery[]> {
    await tx.execute(sql`savepoint failure_hook`);
    try {
      const list = await app.failed(tx, run, reason, await loadActions(tx, run.id));
      await tx.execute(sql`release savepoint failure_hook`);
      return list;
    } catch (err) {
      await tx.execute(sql`rollback to savepoint failure_hook`);
      log(`Run ${run.id}'s failure hook threw; storing a plain note instead`, err instanceof Error ? err.message : err);
      await tx.execute(
        sql`insert into messages (conversation_id, run_id, role, content, meta)
            values (${run.conversationId}, ${run.id}, 'notice', 'A request failed, and so did telling you about it.', ${json({ reason })})`,
      );
      return [];
    }
  }

  // ---- Ingress ------------------------------------------------------------

  /** Records a channel event and its run in one transaction. A repeat of the same event adds nothing. */
  async function ingest(i: IngestInput): Promise<IngestResult> {
    return transaction(db, async (tx) => {
      const fresh = await count(
        tx,
        sql`insert into inbound (channel, key) values (${i.channel}, ${i.key}) on conflict do nothing`,
      );
      if (fresh === 0) {
        const [row] = await rows(
          tx,
          sql`select r.id, r.state, (c.lease_until is null or c.lease_until < now()) as free
              from inbound i join runs r on r.id = i.run_id join conversations c on c.id = r.conversation_id
              where i.channel = ${i.channel} and i.key = ${i.key}`,
        );
        // Drain again only if the run still waits, or whoever held its chat is gone.
        const drain = Boolean(row) && (row.state === "queued" || (row.state === "running" && row.free));
        return { runId: row?.id ?? 0, duplicate: true, drain };
      }
      const runId = await insertRun(tx, i);
      await tx.execute(sql`update inbound set run_id = ${runId} where channel = ${i.channel} and key = ${i.key}`);
      if (i.message) {
        await tx.execute(
          sql`insert into messages (conversation_id, run_id, role, content, meta)
              values (${i.conversationId}, ${runId}, 'user', ${i.message.content}, ${json(i.message.meta)})`,
        );
      }
      return { runId, duplicate: false, drain: true };
    });
  }

  // ---- Claiming -----------------------------------------------------------

  /** Claims the free conversation with the oldest eligible work, and its head run. */
  async function claimNext(): Promise<Claim | null> {
    if (stopping) return null;
    return transaction(db, async (tx) => {
      for (;;) {
        // A free conversation has no lease, or an expired one. Locking it is what
        // keeps a second instance out of the same chat; it skips this row.
        const [conv] = await rows(
          tx,
          sql`select c.id from conversations c
              where (c.lease_until is null or c.lease_until < now())
                and exists (select 1 from runs r where r.conversation_id = c.id
                            and r.state in ('queued', 'running') and r.not_before <= now())
              order by (select min(r.created_at) from runs r where r.conversation_id = c.id
                        and r.state in ('queued', 'running') and r.not_before <= now())
              for update of c skip locked
              limit 1`,
        );
        if (!conv) return null;

        // The head: a run left `running` by a holder that crashed comes first, so
        // later runs never overtake it. Then the oldest eligible queued run.
        const [head] = await rows(
          tx,
          sql`select * from runs
              where conversation_id = ${conv.id} and state in ('queued', 'running') and not_before <= now()
              order by (state = 'running') desc, created_at, id
              limit 1 for update`,
        );
        if (!head) return null;
        const run = toRun(head);

        if (run.attempt >= maxAttempts) {
          // Its last attempt was interrupted. Give up on it, tell the owner, and
          // look at the next run in this chat, still holding the lock.
          await tx.execute(
            sql`update runs set state = 'failed', error = 'interrupted', finished_at = now() where id = ${run.id}`,
          );
          // Revoke the old holder, who may still be alive and only slow: its
          // heartbeat, tool changes and failure handling must all fail now.
          await tx.execute(sql`update conversations set holder_token = null, lease_until = null where id = ${conv.id}`);
          await insertDeliveries(tx, run.id, await failedSafely(tx, run, "interrupted"));
          log(`Run ${run.id} failed after ${run.attempt} interrupted attempts`);
          continue;
        }

        const token = randomUUID();
        await tx.execute(
          sql`update conversations set holder_token = ${token}, lease_until = now() + make_interval(secs => ${leaseSeconds})
              where id = ${conv.id}`,
        );
        const [claimed] = await rows(
          tx,
          sql`update runs set state = 'running', attempt = attempt + 1, claim_token = ${token},
                started_at = coalesce(started_at, now()), error = null
              where id = ${run.id} returning *`,
        );
        return { conversationId: conv.id, token, run: toRun(claimed), priorActions: await loadActions(tx, run.id) };
      }
    });
  }

  /** Extends the lease. False means another holder took the conversation. */
  async function heartbeat(claim: Claim): Promise<boolean> {
    const n = await count(
      db,
      sql`update conversations set lease_until = now() + make_interval(secs => ${leaseSeconds})
          where id = ${claim.conversationId} and holder_token = ${claim.token}`,
    );
    return n === 1;
  }

  /** Runs `fn` in a transaction that holds the conversation, only while the claim is still current. */
  async function fenced<T>(claim: Claim, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return transaction(db, async (tx) => {
      const n = await count(
        tx,
        sql`select 1 from conversations c join runs r on r.id = ${claim.run.id}
            where c.id = ${claim.conversationId} and c.holder_token = ${claim.token}
              and r.claim_token = ${claim.token} and r.state = 'running'
            for update of c`,
      );
      if (n !== 1) throw new LostClaimError();
      return fn(tx);
    });
  }

  // ---- Running ------------------------------------------------------------

  function context(claim: Claim, signal: AbortSignal): RunContext {
    const prior = new Map<string, Action[]>();
    for (const a of claim.priorActions) prior.set(a.kind, [...(prior.get(a.kind) ?? []), a]);
    const used = new Map<string, number>();
    return {
      claim,
      signal,
      async act<T>(kind: string, apply: (tx: Tx) => Promise<T>) {
        const earlier = prior.get(kind) ?? [];
        const n = used.get(kind) ?? 0;
        used.set(kind, n + 1);
        if (n < earlier.length) return { result: earlier[n].result as T, replayed: true };
        signal.throwIfAborted();
        return fenced(claim, async (tx) => {
          const result = await apply(tx);
          await tx.execute(
            sql`insert into actions (run_id, seq, attempt, kind, result)
                values (${claim.run.id}, (select coalesce(max(seq), 0) + 1 from actions where run_id = ${claim.run.id}),
                        ${claim.run.attempt}, ${kind}, ${json(result)})`,
          );
          return { result, replayed: false };
        });
      },
      emit(event: RunEvent) {
        opts.onEvent?.(claim.run, event);
      },
    };
  }

  /** Clears the lease and stores the outcome. Returns the new deliveries. */
  async function finish(claim: Claim, outcome: Extract<Outcome, { status: "done" }>): Promise<number[]> {
    return transaction(db, async (tx) => {
      const released = await count(
        tx,
        sql`update conversations set holder_token = null, lease_until = null
            where id = ${claim.conversationId} and holder_token = ${claim.token}`,
      );
      if (released !== 1) throw new LostClaimError();
      const done = await count(
        tx,
        sql`update runs set state = 'done', result = ${json(outcome.result ?? { text: outcome.text })}, finished_at = now()
            where id = ${claim.run.id} and claim_token = ${claim.token} and state = 'running'`,
      );
      if (done !== 1) throw new LostClaimError();
      const deliveries = await app.completed(tx, claim.run, outcome, await loadActions(tx, claim.run.id));
      return insertDeliveries(tx, claim.run.id, deliveries);
    });
  }

  /** Puts the run back until `until`. A deferral doesn't count as an attempt. */
  async function defer(claim: Claim, until: Date, reason?: string): Promise<void> {
    await fenced(claim, async (tx) => {
      await tx.execute(
        sql`update runs set state = 'queued', not_before = ${until}, attempt = attempt - 1, error = ${reason ?? null}
            where id = ${claim.run.id} and claim_token = ${claim.token} and state = 'running'`,
      );
      await tx.execute(
        sql`update conversations set holder_token = null, lease_until = null where id = ${claim.conversationId}`,
      );
    });
  }

  /** After an error: try again right away (keeping the chat's order), or fail after the last attempt. */
  async function failOrRetry(claim: Claim, error: unknown): Promise<number[]> {
    const message = error instanceof Error ? error.message : String(error);
    return fenced(claim, async (tx) => {
      let ids: number[] = [];
      if (claim.run.attempt < maxAttempts) {
        await tx.execute(
          sql`update runs set state = 'queued', error = ${message}
              where id = ${claim.run.id} and claim_token = ${claim.token} and state = 'running'`,
        );
      } else {
        await tx.execute(
          sql`update runs set state = 'failed', error = ${message}, finished_at = now()
              where id = ${claim.run.id} and claim_token = ${claim.token} and state = 'running'`,
        );
        ids = await insertDeliveries(tx, claim.run.id, await failedSafely(tx, claim.run, message));
      }
      await tx.execute(
        sql`update conversations set holder_token = null, lease_until = null where id = ${claim.conversationId}`,
      );
      return ids;
    });
  }

  /** Runs a claimed run to its end: done, deferred, retried or failed. Heartbeats the lease meanwhile. */
  async function runClaim(claim: Claim): Promise<number[]> {
    const controller = new AbortController();
    active.set(claim.run.id, controller);
    let lastBeat = Date.now();
    let beating = false;
    const timer = setInterval(async () => {
      if (beating) return;
      beating = true;
      try {
        if (await heartbeat(claim)) lastBeat = Date.now();
        else controller.abort(new LostClaimError());
      } catch (err) {
        // Can't reach the database. Once the lease has surely expired, someone
        // else may have the chat, so stop spending on this run.
        if (Date.now() - lastBeat > leaseSeconds * 1000) controller.abort(new LostClaimError("Lease expired unconfirmed"));
      } finally {
        beating = false;
      }
    }, heartbeatMs);

    try {
      const outcome = await app.execute(claim.run, context(claim, controller.signal));
      controller.signal.throwIfAborted();
      if (outcome.status === "defer") {
        await defer(claim, outcome.until, outcome.reason);
        log(`Run ${claim.run.id} deferred until ${outcome.until.toISOString()}`);
        return [];
      }
      return await finish(claim, outcome);
    } catch (err) {
      const reason = controller.signal.reason ?? err;
      if (reason instanceof LostClaimError || err instanceof LostClaimError) {
        log(`Run ${claim.run.id} lost its claim; leaving it to the new holder`);
      } else if (reason instanceof ShutdownError) {
        // Keep the lease: it expires, and another instance reclaims the run.
        log(`Run ${claim.run.id} stopped by shutdown; it will be reclaimed`);
      } else {
        log(`Run ${claim.run.id} attempt ${claim.run.attempt} failed`, err instanceof Error ? err.message : err);
        return await failOrRetry(claim, err).catch((e) => {
          log(`Couldn't record run ${claim.run.id}'s failure`, e?.message);
          return [];
        });
      }
      return [];
    } finally {
      clearInterval(timer);
      active.delete(claim.run.id);
    }
  }

  // ---- Deliveries ---------------------------------------------------------

  /** Claims a due delivery, or only delivery `onlyId`. */
  async function claimDelivery(onlyId?: number): Promise<Delivery | null> {
    return transaction(db, async (tx) => {
      // Past their 24 hours, deliveries stop retrying and wait for the Retry button.
      await tx.execute(
        sql`update deliveries set state = 'failed', last_error = coalesce(last_error, 'gave up')
            where give_up_at < now() and (state = 'pending' or (state = 'sending' and lease_until < now()))`,
      );
      const [row] = await rows(
        tx,
        sql`select id from deliveries
            where ((state = 'pending' and next_attempt_at <= now()) or (state = 'sending' and lease_until < now()))
              and (${onlyId ?? null}::int is null or id = ${onlyId ?? null}::int)
            order by id for update skip locked limit 1`,
      );
      if (!row) return null;
      // The attempt number is stored before sending, so a send that went through
      // but whose answer was lost is marked as a possible repeat next time.
      const [d] = await rows(
        tx,
        sql`update deliveries set state = 'sending', attempt = attempt + 1, claim_token = ${randomUUID()},
              lease_until = now() + make_interval(secs => ${deliveryLeaseSeconds})
            where id = ${row.id} returning *`,
      );
      return toDelivery(d);
    });
  }

  /** Extends a delivery's lease, and says whether this sender still holds it. */
  async function holdDelivery(d: Delivery, partsSent?: number): Promise<boolean> {
    const n = await count(
      db,
      sql`update deliveries set lease_until = now() + make_interval(secs => ${deliveryLeaseSeconds}),
            progress = coalesce(${partsSent ?? null}::int, progress)
          where id = ${d.id} and claim_token = ${d.claimToken} and state = 'sending'`,
    );
    return n === 1;
  }

  async function send(d: Delivery): Promise<boolean> {
    // The deadline is set before renewing, so it's always earlier than the
    // lease the renewal sets, however long this instance stalls in between.
    const deadline = Date.now() + deliveryLeaseSeconds * 750;
    // A sender that stalled past its lease may have been replaced, and the
    // replacement may have sent already. Check before sending anything, and
    // before each further part of a long message.
    if (!(await holdDelivery(d))) {
      log(`Delivery ${d.id} was taken over before sending; not sending`);
      return false;
    }
    try {
      const sender = app.senders[d.channel];
      if (!sender) throw new Error(`No sender for channel "${d.channel}"`);
      // Give up well within the lease, so no one else sends while this one
      // still might. Senders must pass `signal` to their I/O and check it
      // before each part; JavaScript can't stop a sender that ignores it.
      const signal = AbortSignal.timeout(Math.max(0, deadline - Date.now()));
      signal.throwIfAborted();
      await sender(
        { id: d.id, destination: d.destination, text: d.text, meta: d.meta ?? null, resend: d.attempt > 1, progress: d.progress, signal },
        async (partsSent) => {
          if (!(await holdDelivery(d, partsSent))) throw new LostClaimError("Another sender has this delivery now");
        },
      );
      signal.throwIfAborted();
      return (
        (await count(
          db,
          sql`update deliveries set state = 'sent', sent_at = now(), last_error = null
              where id = ${d.id} and claim_token = ${d.claimToken} and state = 'sending'`,
        )) === 1
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`Delivery ${d.id} attempt ${d.attempt} failed`, message);
      // Back off 1 minute, doubling up to an hour.
      await db
        .execute(
          sql`update deliveries set state = 'pending', last_error = ${message},
                next_attempt_at = now() + make_interval(secs => least(3600, 60 * power(2, attempt - 1)))
              where id = ${d.id} and claim_token = ${d.claimToken} and state = 'sending'`,
        )
        .catch((e) => log(`Couldn't record delivery ${d.id}'s failure`, e?.message));
      return false;
    }
  }

  /** Sends every delivery that's due. */
  async function sendDue(): Promise<number> {
    let sent = 0;
    while (!stopping && (await mayAcquire())) {
      const d = await claimDelivery();
      if (!d) break;
      if (await send(d)) sent++;
    }
    return sent;
  }

  /** The console's Retry button for a delivery that gave up. */
  async function retryDelivery(id: number): Promise<boolean> {
    return (
      (await count(
        db,
        sql`update deliveries set state = 'pending', next_attempt_at = now(), give_up_at = now() + interval '24 hours'
            where id = ${id} and state = 'failed'`,
      )) === 1
    );
  }

  // ---- Schedules ----------------------------------------------------------

  /** Turns due schedules into runs. Each one's next time is set in the same transaction, so it can't fire twice. */
  async function convertDueSchedules(): Promise<number> {
    if (!app.scheduled) return 0;
    let converted = 0;
    while (!stopping && (await mayAcquire())) {
      const did = await transaction(db, async (tx) => {
        const [s] = await rows(
          tx,
          sql`select *, now() as db_now from schedules where not paused and next_run_at <= now()
              order by next_run_at for update skip locked limit 1`,
        );
        if (!s) return false;
        const schedule: Schedule = {
          id: s.id,
          conversationId: s.conversation_id,
          instruction: s.instruction,
          mode: s.mode,
          rule: s.rule,
          nextRunAt: new Date(s.next_run_at),
        };
        // Planning and applying the plan run in a savepoint. If either throws,
        // the failure is recorded under this same row lock, so it can't race
        // another instance, and the schedule backs off instead of blocking.
        await tx.execute(sql`savepoint convert`);
        try {
          const work = await app.scheduled!(tx, schedule, new Date(s.db_now));
          if (work.input !== undefined) {
            await insertRun(tx, { conversationId: s.conversation_id, kind: work.kind ?? "schedule", origin: "schedule", input: work.input });
          }
          if (work.notice) {
            await tx.execute(
              sql`insert into messages (conversation_id, role, content) values (${s.conversation_id}, 'notice', ${work.notice.message})`,
            );
            await insertDeliveries(tx, null, [work.notice]);
          }
          await tx.execute(sql`update schedules set next_run_at = ${work.nextRunAt}, updated_at = now() where id = ${s.id}`);
          await tx.execute(sql`release savepoint convert`);
        } catch (err) {
          await tx.execute(sql`rollback to savepoint convert`);
          log(`Schedule ${s.id} couldn't be converted`, err instanceof Error ? err.message : err);
          await scheduleFailed(tx, s.id, err instanceof Error ? err.message : String(err));
        }
        return true;
      });
      if (!did) break;
      converted++;
    }
    return converted;
  }

  /** Backs off a schedule that can't be planned, and pauses it with a note after 3 tries in a row. */
  async function scheduleFailed(tx: Tx, id: number, message: string): Promise<void> {
    const [s] = await rows(
      tx,
      sql`update schedules set failures = failures + 1, paused = failures + 1 >= 3,
            next_run_at = now() + make_interval(mins => 5 * (failures + 1)), updated_at = now()
          where id = ${id} returning conversation_id, paused`,
    );
    if (s?.paused) {
      await tx.execute(
        sql`insert into messages (conversation_id, role, content, meta)
            values (${s.conversation_id}, 'notice', ${`Schedule ${id} failed 3 times in a row, so it's paused.`}, ${json({ error: message })})`,
      );
    }
  }

  // ---- Draining -----------------------------------------------------------

  /** One step of a drain. A failing step is logged, and the others still run. */
  async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      log(`Drain step "${name}" failed`, err instanceof Error ? err.message : err);
      return undefined;
    }
  }

  async function drainOnce(): Promise<void> {
    await step("send", sendDue);
    await step("schedules", convertDueSchedules);
    for (;;) {
      if (stopping || !(await step("live check", mayAcquire))) break;
      const claim = await step("claim", claimNext);
      if (!claim) break;
      const own = await runClaim(claim);
      // The run's own reply goes out from here, even if a new deploy took over
      // meanwhile; anything else waits for the live instance.
      await step("send reply", async () => {
        for (const id of own) {
          const d = await claimDelivery(id);
          if (d) await send(d);
        }
      });
      await step("send", sendDue);
    }
  }

  /**
   * Works until nothing is left. Calls while a drain runs join it, and make it
   * look once more before it ends. Never rejects.
   */
  function drain(): Promise<void> {
    if (draining) {
      again = true;
      return draining;
    }
    draining = (async () => {
      try {
        do {
          again = false;
          await drainOnce();
        } while (again && !stopping);
      } catch (err) {
        log("Drain failed", err instanceof Error ? err.message : err);
      } finally {
        draining = null;
      }
    })();
    return draining;
  }

  /**
   * Stops new claims, gives running runs `graceMs` to finish, then aborts them
   * without releasing their leases, so they expire and another instance
   * reclaims the runs.
   */
  async function shutdown(graceMs = 60_000): Promise<void> {
    stopping = true;
    const current = draining;
    if (!current) return;
    const finished = await Promise.race([current.then(() => true), sleep(graceMs).then(() => false)]);
    if (finished) return;
    for (const c of active.values()) c.abort(new ShutdownError());
    await Promise.race([current, sleep(5_000)]);
  }

  return {
    ingest,
    claimNext,
    heartbeat,
    fenced,
    runClaim,
    finish,
    claimDelivery,
    send,
    sendDue,
    retryDelivery,
    convertDueSchedules,
    drain,
    shutdown,
    /** Runs executing on this instance. */
    activeRuns: () => [...active.keys()],
  };
}

export type Queue = ReturnType<typeof createQueue>;
