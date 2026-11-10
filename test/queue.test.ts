import { setTimeout as sleep } from "node:timers/promises";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { transaction } from "../src/db.ts";
import { LostClaimError, RESEND_NOTE, type Claim, type Queue } from "../src/queue.ts";
import { enqueue, expireLease, freshDatabase, query, queueOn, testApp, type TestDatabase, workDue } from "./helpers.ts";

let t: TestDatabase;
beforeEach(async () => {
  t = await freshDatabase();
});
afterEach(async () => {
  await t.close();
});

const runRow = async (db: ReturnType<TestDatabase["connect"]>, id: number) =>
  (await query(db, sql`select * from runs where id = ${id}`))[0];

describe("claiming", () => {
  it("lets exactly one of many instances claim a conversation, and gives it the head run", async () => {
    const setup = t.connect();
    const { app } = testApp();
    const instances = Array.from({ length: 8 }, () => queueOn(t.connect(2), app));
    for (let round = 0; round < 25; round++) {
      const conv = `race-${round}`;
      const first = await enqueue(setup, conv);
      await enqueue(setup, conv);
      const claims = (await Promise.all(instances.map((q) => q.claimNext()))).filter(Boolean) as Claim[];
      expect(claims).toHaveLength(1);
      expect(claims[0].run.id).toBe(first);
    }
  });

  it("doesn't start a second run in a chat while another instance is mid-claim (review M1-1)", async () => {
    const setup = t.connect();
    const { app } = testApp();
    const b = queueOn(t.connect(), app);
    await enqueue(setup, "c");
    await enqueue(setup, "c");

    // Instance A has locked the conversation in its claim transaction but hasn't committed.
    const a = new pg.Client({ connectionString: t.url });
    await a.connect();
    await a.query("begin");
    await a.query("select id from conversations where id = 'c' for update");

    // Under row locks on runs alone, B would skip A's run and claim the second one.
    expect(await b.claimNext()).toBeNull();

    await a.query(
      "update conversations set holder_token = gen_random_uuid(), lease_until = now() + interval '90 seconds' where id = 'c'",
    );
    await a.query("commit");
    await a.end();
    expect(await b.claimNext()).toBeNull();
  });

  it("reclaims a crashed head run before later runs, with a new token", async () => {
    const setup = t.connect();
    const { app } = testApp();
    const a = queueOn(t.connect(), app);
    const b = queueOn(t.connect(), app);
    const first = await enqueue(setup, "c");
    await enqueue(setup, "c");

    const ca = (await a.claimNext())!;
    expect(ca.run.id).toBe(first);
    // A crashes: no finish, no heartbeat. Its lease runs out.
    expect(await b.claimNext()).toBeNull();
    await expireLease(setup, "c");

    const cb = (await b.claimNext())!;
    expect(cb.run.id).toBe(first);
    expect(cb.run.attempt).toBe(2);
    expect(cb.token).not.toBe(ca.token);
  });

  it("keeps a crashed run ahead of an older run that only just became eligible", async () => {
    const setup = t.connect();
    const q = queueOn(t.connect(), testApp().app);
    await setup.execute(sql`insert into conversations (id) values ('c')`);
    const [{ id: deferred }] = await query(
      setup,
      sql`insert into runs (conversation_id, kind, origin, input, not_before) values ('c', 'test', 'schedule', '{}', now() + interval '1 hour') returning id`,
    );
    const live = await enqueue(setup, "c");
    expect((await q.claimNext())!.run.id).toBe(live);
    // The holder crashes. By the time its lease runs out, the deferred run is due too.
    await setup.execute(sql`update runs set not_before = now() where id = ${deferred}`);
    await expireLease(setup, "c");
    expect((await q.claimNext())!.run).toMatchObject({ id: live, attempt: 2 });
  });

  it("fences a holder whose lease expired: no heartbeat, change or finish lands", async () => {
    const setup = t.connect();
    const { app } = testApp();
    const a = queueOn(t.connect(), app);
    const b = queueOn(t.connect(), app);
    const runId = await enqueue(setup, "c");

    const ca = (await a.claimNext())!;
    await expireLease(setup, "c");
    const cb = (await b.claimNext())!;
    const [{ lease_until: leaseBefore }] = await query(setup, sql`select lease_until from conversations where id = 'c'`);

    expect(await a.heartbeat(ca)).toBe(false);
    const [{ lease_until: leaseAfter }] = await query(setup, sql`select lease_until from conversations where id = 'c'`);
    expect(leaseAfter).toEqual(leaseBefore);

    await expect(a.fenced(ca, async (tx) => tx.execute(sql`insert into effects (run_id) values (${runId})`))).rejects.toThrow(
      LostClaimError,
    );
    await expect(a.finish(ca, { status: "done", text: "stale" })).rejects.toThrow(LostClaimError);

    await b.finish(cb, { status: "done", text: "fresh" });
    expect((await runRow(setup, runId)).state).toBe("done");
    const replies = await query(setup, sql`select content from messages where run_id = ${runId}`);
    expect(replies.map((r) => r.content)).toEqual(["fresh"]);
    expect(await query(setup, sql`select * from effects`)).toHaveLength(0);
    expect(await query(setup, sql`select * from deliveries`)).toHaveLength(1);
  });

  it("aborts a running holder once its heartbeat finds the claim gone", async () => {
    const setup = t.connect();
    let signalled = false;
    const { app } = testApp({
      execute: async (_run, ctx) => {
        await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve()));
        signalled = true;
        return { status: "done", text: "too late" };
      },
    });
    const a = queueOn(t.connect(), app, { heartbeatMs: 50 });
    const b = queueOn(t.connect(), testApp().app);
    const runId = await enqueue(setup, "c");

    const ca = (await a.claimNext())!;
    const running = a.runClaim(ca);
    await expireLease(setup, "c");
    const cb = (await b.claimNext())!;
    await running;
    expect(signalled).toBe(true);
    // A wrote nothing; B still holds the chat and finishes it.
    expect((await runRow(setup, runId)).claim_token).toBe(cb.token);
    await b.finish(cb, { status: "done", text: "fresh" });
    expect(await query(setup, sql`select content from messages where run_id = ${runId}`)).toEqual([{ content: "fresh" }]);
  });

  it("fails a run interrupted on its last attempt, with a note, and moves on", async () => {
    const setup = t.connect();
    const { app } = testApp();
    const q = queueOn(t.connect(), app);
    const first = await enqueue(setup, "c");
    const second = await enqueue(setup, "c");

    await q.claimNext();
    await expireLease(setup, "c");
    await q.claimNext(); // attempt 2
    await expireLease(setup, "c");

    const next = (await q.claimNext())!;
    expect(next.run.id).toBe(second);
    const failed = await runRow(setup, first);
    expect(failed.state).toBe("failed");
    expect(failed.error).toBe("interrupted");
    expect(await query(setup, sql`select text, state from deliveries where run_id = ${first}`)).toEqual([
      { text: `failed ${first}`, state: "pending" },
    ]);
  });

  it("retries a run that threw once, then fails it with a note", async () => {
    const setup = t.connect();
    const { app } = testApp({
      execute: async () => {
        throw new Error("model overloaded");
      },
    });
    const q = queueOn(t.connect(), app);
    const runId = await enqueue(setup, "c");

    await q.runClaim((await q.claimNext())!);
    expect(await runRow(setup, runId)).toMatchObject({ state: "queued", attempt: 1, error: "model overloaded" });
    await q.runClaim((await q.claimNext())!);
    expect(await runRow(setup, runId)).toMatchObject({ state: "failed", attempt: 2 });
    expect(await query(setup, sql`select role from messages where run_id = ${runId}`)).toEqual([{ role: "notice" }]);
    expect(await q.claimNext()).toBeNull();
  });
});

describe("failures", () => {
  it("revokes a slow holder when its run is given up on (review Q1-1)", async () => {
    const setup = t.connect();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { app } = testApp({
      execute: async () => {
        await gate;
        throw new Error("late failure");
      },
    });
    const a = queueOn(t.connect(), app, { heartbeatMs: 60_000 });
    const b = queueOn(t.connect(), testApp().app);
    const runId = await enqueue(setup, "c");

    await a.claimNext();
    await expireLease(setup, "c");
    const second = (await a.claimNext())!; // attempt 2, and A is still alive, just slow
    const running = a.runClaim(second);
    await expireLease(setup, "c");
    expect(await b.claimNext()).toBeNull(); // gives up on the run

    expect(await a.heartbeat(second)).toBe(false);
    release();
    await running;
    expect((await runRow(setup, runId)).state).toBe("failed");
    expect(await query(setup, sql`select count(*)::int as n from deliveries where run_id = ${runId}`)).toEqual([{ n: 1 }]);
  });

  it("still ends a run when the failure hook throws (review Q1-4)", async () => {
    const setup = t.connect();
    const { app } = testApp({
      execute: async () => {
        throw new Error("model down");
      },
      failed: async () => {
        throw new Error("broken route");
      },
    });
    const q = queueOn(t.connect(), app, { maxAttempts: 1 });
    const first = await enqueue(setup, "c");
    const second = await enqueue(setup, "c");
    await q.runClaim((await q.claimNext())!);
    expect((await runRow(setup, first)).state).toBe("failed");
    expect(await query(setup, sql`select role from messages where run_id = ${first}`)).toEqual([{ role: "notice" }]);
    expect((await q.claimNext())!.run.id).toBe(second);
  });

  it("backs off and pauses a schedule that can't be planned, without blocking other work (review Q1-5)", async () => {
    const setup = t.connect();
    const { app, sent } = testApp({
      scheduled: async () => {
        throw new Error("bad rule");
      },
    });
    const q = queueOn(t.connect(), app);
    await setup.execute(sql`insert into conversations (id) values ('c')`);
    await setup.execute(sql`insert into schedules (conversation_id, instruction, rule, next_run_at) values ('c', 'x', '{}', now())`);
    await enqueue(setup, "c");
    await q.drain();
    expect(sent).toHaveLength(1);
    const [s] = await query(setup, sql`select failures, paused, next_run_at > now() as later from schedules`);
    expect(s).toEqual({ failures: 1, paused: false, later: true });

    for (let i = 0; i < 2; i++) {
      await setup.execute(sql`update schedules set next_run_at = now()`);
      await q.drain();
    }
    expect(await query(setup, sql`select failures, paused from schedules`)).toEqual([{ failures: 3, paused: true }]);
    expect(await query(setup, sql`select count(*)::int as n from messages where role = 'notice'`)).toEqual([{ n: 1 }]);
    expect(await workDue(t.connect(1))).toBe(false);
  });
});

describe("schedule conversion", () => {
  it("records a failure that happens after planning, too (review Q3-1)", async () => {
    const setup = t.connect();
    const { app } = testApp({
      // Planning succeeds, but its input can't be stored (JSON can't hold a BigInt).
      scheduled: async () => ({ input: { id: 1n }, nextRunAt: null }),
    });
    const q = queueOn(t.connect(), app);
    await setup.execute(sql`insert into conversations (id) values ('c')`);
    await setup.execute(sql`insert into schedules (conversation_id, instruction, rule, next_run_at) values ('c', 'x', '{}', now())`);
    await q.drain();
    expect(await query(setup, sql`select failures, next_run_at > now() as later from schedules`)).toEqual([{ failures: 1, later: true }]);
    expect(await query(setup, sql`select count(*)::int as n from runs`)).toEqual([{ n: 0 }]);
  });
});

describe("the live instance", () => {
  it("stops taking work once another instance is live, but sends its own run's reply (review Q1-6)", async () => {
    const setup = t.connect();
    let live = true;
    const { app, sent } = testApp({
      execute: async (run) => {
        live = false; // a new deploy's instance got a request meanwhile
        return { status: "done", text: `answer ${run.id}` };
      },
    });
    const q = queueOn(t.connect(), app, { mayAcquire: async () => live });
    const first = await enqueue(setup, "c");
    await enqueue(setup, "c");
    await q.drain();
    expect(sent.map((s) => s.text)).toEqual([`answer ${first}`]);
    expect(await query(setup, sql`select state from runs order by id`)).toEqual([{ state: "done" }, { state: "queued" }]);
  });
});

describe("transactions", () => {
  it("has the database's own timeouts from a connection's first query", async () => {
    const db = t.connect(1);
    const [row] = await query(db, sql`select current_setting('statement_timeout') as st, current_setting('idle_in_transaction_session_timeout') as it`);
    expect(row).toEqual({ st: "10s", it: "30s" });
  });

  it("destroys a connection whose rollback didn't go through, so nothing it held commits later (review Q1-3)", async () => {
    const db = t.connect(1);
    let sabotage = true;
    db.$client.on("acquire", (client) => {
      if (!sabotage) return;
      const original = client.query.bind(client) as (...args: any[]) => any;
      (client as any).query = (q: unknown, ...rest: unknown[]) => {
        if (q === "rollback" && sabotage) {
          sabotage = false;
          return Promise.reject(new Error("rollback lost"));
        }
        return original(q, ...rest);
      };
    });
    await expect(
      transaction(db, async (tx) => {
        await tx.execute(sql`insert into effects (label) values ('half done')`);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await transaction(db, async (tx) => {
      await tx.execute(sql`insert into effects (label) values ('next')`);
    });
    expect(await query(t.connect(), sql`select label from effects`)).toEqual([{ label: "next" }]);
  });
});

describe("actions", () => {
  it("doesn't repeat a change when a run is retried", async () => {
    const setup = t.connect();
    const replays: boolean[] = [];
    let attempt = 0;
    const { app } = testApp({
      execute: async (run, ctx) => {
        attempt++;
        const r = await ctx.act("remember", async (tx) => {
          const [row] = (
            (await tx.execute(sql`insert into effects (run_id, label) values (${run.id}, 'note') returning id`)) as any
          ).rows;
          return { noteId: row.id };
        });
        replays.push(r.replayed);
        if (attempt === 1) {
          // The first attempt dies here, after its change committed. (Under load the
          // heartbeat may already have aborted it, so don't wait for an event that fired.)
          if (!ctx.signal.aborted) await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve));
          throw ctx.signal.reason;
        }
        return { status: "done", text: `saved note ${r.result.noteId}` };
      },
    });
    const a = queueOn(t.connect(), app, { heartbeatMs: 50 });
    const b = queueOn(t.connect(), app);
    const runId = await enqueue(setup, "c");

    const running = a.runClaim((await a.claimNext())!);
    // Wait until A's change has committed (and released the chat's row lock).
    while ((await query(setup, sql`select 1 from actions`)).length === 0) await sleep(20);
    await expireLease(setup, "c");
    const cb = (await b.claimNext())!;
    expect(cb.priorActions).toMatchObject([{ seq: 1, attempt: 1, kind: "remember" }]);
    await running;
    await b.runClaim(cb);

    expect(replays).toEqual([false, true]);
    expect(await query(setup, sql`select * from effects`)).toHaveLength(1);
    expect((await runRow(setup, runId)).state).toBe("done");
  });
});

describe("deliveries", () => {
  async function oneDelivery(setup: ReturnType<TestDatabase["connect"]>, text = "hello") {
    const [{ id: runId }] = await query(
      setup,
      sql`insert into conversations (id) values ('c') on conflict do nothing; select 1`,
    ).then(async () => query(setup, sql`insert into runs (conversation_id, kind, origin, input, state) values ('c', 'test', 'test', '{}', 'done') returning id`));
    const [d] = await query(
      setup,
      sql`insert into deliveries (run_id, channel, destination, text) values (${runId}, 'test', 'chat', ${text}) returning id`,
    );
    return d.id as number;
  }

  it("lets one sender at a time claim a delivery", async () => {
    const setup = t.connect();
    await oneDelivery(setup);
    const { app } = testApp();
    const senders = Array.from({ length: 6 }, () => queueOn(t.connect(2), app));
    const claimed = (await Promise.all(senders.map((q) => q.claimDelivery()))).filter(Boolean);
    expect(claimed).toHaveLength(1);
  });

  it("backs off after a failure and marks the next attempt as a possible repeat", async () => {
    const setup = t.connect();
    const id = await oneDelivery(setup);
    let fail = true;
    const seen: boolean[] = [];
    const { app } = testApp({
      senders: {
        test: async (d) => {
          seen.push(d.resend);
          if (fail) throw new Error("telegram timeout");
        },
      },
    });
    const q = queueOn(t.connect(), app);

    expect(await q.sendDue()).toBe(0);
    const [after] = await query(
      setup,
      sql`select state, attempt, extract(epoch from next_attempt_at - now()) as wait from deliveries where id = ${id}`,
    );
    expect(after).toMatchObject({ state: "pending", attempt: 1 });
    expect(Number(after.wait)).toBeGreaterThan(50);
    expect(await q.sendDue()).toBe(0); // not due yet

    fail = false;
    await setup.execute(sql`update deliveries set next_attempt_at = now() where id = ${id}`);
    expect(await q.sendDue()).toBe(1);
    expect(seen).toEqual([false, true]);
    expect((await query(setup, sql`select state from deliveries where id = ${id}`))[0].state).toBe("sent");
  });

  it("reclaims a delivery whose sender crashed mid-send, as a possible repeat", async () => {
    const setup = t.connect();
    const id = await oneDelivery(setup);
    const { app, sent } = testApp();
    const a = queueOn(t.connect(), app);
    const b = queueOn(t.connect(), app);

    const d = (await a.claimDelivery())!; // A claims, then dies before finishing
    expect(await b.claimDelivery()).toBeNull();
    await setup.execute(sql`update deliveries set lease_until = now() - interval '1 second' where id = ${id}`);
    expect(await b.sendDue()).toBe(1);
    expect(sent).toEqual([{ destination: "chat", text: "hello", resend: true, progress: 0 }]);
    // A wakes up late: it must not send again, unmarked, or overwrite B's success.
    expect(await a.send(d)).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it("stops a sender that stalled past its lease from sending when it resumes (review Q1-2)", async () => {
    const setup = t.connect();
    await oneDelivery(setup);
    const sent: boolean[] = [];
    let stall = true;
    const { app } = testApp({
      senders: {
        test: async (d) => {
          if (stall) {
            stall = false;
            await sleep(2600); // A is inside its sender when it stalls
          }
          d.signal.throwIfAborted();
          sent.push(d.resend);
        },
      },
    });
    const a = queueOn(t.connect(), app, { deliveryLeaseSeconds: 2 });
    const b = queueOn(t.connect(), app, { deliveryLeaseSeconds: 2 });
    const aSending = a.sendDue();
    await sleep(2300); // A's lease has run out
    expect(await b.sendDue()).toBe(1);
    expect(await aSending).toBe(0);
    expect(sent).toEqual([true]);
  });

  it("resumes a long message after the parts already sent", async () => {
    const setup = t.connect();
    await oneDelivery(setup, "part1|part2|part3");
    const delivered: string[] = [];
    let crash = true;
    const { app } = testApp({
      senders: {
        test: async (d, markProgress) => {
          const parts = d.text.split("|");
          for (let i = d.progress; i < parts.length; i++) {
            if (crash && i === 2) throw new Error("connection reset");
            delivered.push((i === d.progress && d.resend ? `${RESEND_NOTE} ` : "") + parts[i]);
            await markProgress(i + 1);
          }
        },
      },
    });
    const q = queueOn(t.connect(), app);
    await q.sendDue();
    crash = false;
    await setup.execute(sql`update deliveries set next_attempt_at = now()`);
    await q.sendDue();
    expect(delivered).toEqual(["part1", "part2", `${RESEND_NOTE} part3`]);
  });

  it("gives up after its time and comes back with Retry", async () => {
    const setup = t.connect();
    const id = await oneDelivery(setup);
    const { app } = testApp({
      senders: {
        test: async () => {
          throw new Error("blocked by the user");
        },
      },
    });
    const q = queueOn(t.connect(), app);
    await q.sendDue();
    await setup.execute(sql`update deliveries set give_up_at = now() - interval '1 second', next_attempt_at = now() where id = ${id}`);
    await q.sendDue();
    expect((await query(setup, sql`select state from deliveries where id = ${id}`))[0].state).toBe("failed");
    expect(await workDue(t.connect(1))).toBe(false);

    expect(await q.retryDelivery(id)).toBe(true);
    expect((await query(setup, sql`select state from deliveries where id = ${id}`))[0].state).toBe("pending");
    expect(await workDue(t.connect(1))).toBe(true);
  });
});

describe("waking and deferral", () => {
  it("doesn't wake for deferred work, and deferred work doesn't block a live message", async () => {
    const setup = t.connect();
    const { app } = testApp();
    const q = queueOn(t.connect(), app);
    await setup.execute(sql`insert into conversations (id) values ('c')`);
    await setup.execute(
      sql`insert into runs (conversation_id, kind, origin, input, not_before) values ('c', 'test', 'schedule', '{}', now() + interval '1 day')`,
    );
    expect(await workDue(t.connect(1))).toBe(false);
    expect(await q.claimNext()).toBeNull();

    const live = await enqueue(setup, "c");
    expect(await workDue(t.connect(1))).toBe(true);
    expect((await q.claimNext())!.run.id).toBe(live);
    // While its holder is alive, the chat isn't work to wake for.
    expect(await workDue(t.connect(1))).toBe(false);
  });

  it("skips a chat whose only work is deferred and claims another chat's", async () => {
    const setup = t.connect();
    const q = queueOn(t.connect(), testApp().app);
    await setup.execute(sql`insert into conversations (id) values ('deferred')`);
    await setup.execute(
      sql`insert into runs (conversation_id, kind, origin, input, not_before) values ('deferred', 'test', 'schedule', '{}', now() + interval '1 day')`,
    );
    const live = await enqueue(setup, "live");
    expect((await q.claimNext())!.run.id).toBe(live);
    expect(await q.claimNext()).toBeNull();
  });

  it("defers a run without counting an attempt", async () => {
    const setup = t.connect();
    const until = new Date(Date.now() + 3600_000);
    const { app } = testApp({ execute: async () => ({ status: "defer", until, reason: "spend cap" }) });
    const q = queueOn(t.connect(), app);
    const runId = await enqueue(setup, "c");
    await q.runClaim((await q.claimNext())!);
    const row = await runRow(setup, runId);
    expect(row).toMatchObject({ state: "queued", attempt: 0, error: "spend cap" });
    expect(new Date(row.not_before).getTime()).toBe(until.getTime());
    expect(await workDue(t.connect(1))).toBe(false);
  });

  it("wakes for a run whose holder crashed", async () => {
    const setup = t.connect();
    const q = queueOn(t.connect(), testApp().app);
    await enqueue(setup, "c");
    await q.claimNext();
    expect(await workDue(t.connect(1))).toBe(false);
    await expireLease(setup, "c");
    expect(await workDue(t.connect(1))).toBe(true);
  });
});

describe("ingress and schedules", () => {
  it("records a repeated channel event once", async () => {
    const { app } = testApp();
    const instances = Array.from({ length: 6 }, () => queueOn(t.connect(2), app));
    const event = { channel: "telegram", key: "update-1", conversationId: "c", kind: "test", origin: "telegram", input: {}, message: { content: "hi" } };
    const results = await Promise.all(instances.map((q) => q.ingest(event)));
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(new Set(results.map((r) => r.runId)).size).toBe(1);
    const setup = t.connect();
    expect(await query(setup, sql`select count(*)::int as n from runs`)).toEqual([{ n: 1 }]);
    expect(await query(setup, sql`select count(*)::int as n from messages`)).toEqual([{ n: 1 }]);

    // A retry asks for a drain while the run waits, and not once it's done.
    expect((await instances[0].ingest(event)).drain).toBe(true);
    await instances[0].drain();
    expect((await instances[0].ingest(event)).drain).toBe(false);
  });

  it("turns a due schedule into one run, even with several instances draining", async () => {
    const setup = t.connect();
    const { app } = testApp({
      scheduled: async (_tx, s) => ({ input: { scheduleId: s.id }, nextRunAt: null }),
    });
    const instances = Array.from({ length: 5 }, () => queueOn(t.connect(2), app));
    await setup.execute(sql`insert into conversations (id) values ('c')`);
    await setup.execute(sql`insert into schedules (conversation_id, instruction, rule, next_run_at) values ('c', 'x', '{}', now())`);
    expect(await workDue(t.connect(1))).toBe(true);
    const converted = await Promise.all(instances.map((q) => q.convertDueSchedules()));
    expect(converted.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await query(setup, sql`select kind from runs`)).toEqual([{ kind: "schedule" }]);
    expect(await query(setup, sql`select next_run_at from schedules`)).toEqual([{ next_run_at: null }]);
  });
});

describe("draining", () => {
  it("answers every message once, in order, one run at a time per chat, across instances", async () => {
    const setup = t.connect();
    const running = new Map<string, number>();
    const order = new Map<string, number[]>();
    let overlap = false;
    const make = () =>
      testApp({
        execute: async (run) => {
          const n = (running.get(run.conversationId) ?? 0) + 1;
          running.set(run.conversationId, n);
          if (n > 1) overlap = true;
          order.set(run.conversationId, [...(order.get(run.conversationId) ?? []), run.id]);
          await sleep(Math.random() * 15);
          running.set(run.conversationId, running.get(run.conversationId)! - 1);
          return { status: "done", text: `answer ${run.id}` };
        },
      });
    const apps = [make(), make(), make()];
    const instances = apps.map(({ app }) => queueOn(t.connect(3), app));

    const expected = new Map<string, number[]>();
    for (let i = 0; i < 12; i++) {
      for (const conv of ["a", "b", "c"]) {
        expected.set(conv, [...(expected.get(conv) ?? []), await enqueue(setup, conv)]);
      }
    }
    // Drains start at the same time on every instance, and again while they work.
    await Promise.all([...instances.map((q) => q.drain()), sleep(20).then(() => Promise.all(instances.map((q) => q.drain())))]);
    while (await workDue(t.connect(1))) await Promise.all(instances.map((q) => q.drain()));

    expect(overlap).toBe(false);
    for (const conv of ["a", "b", "c"]) expect(order.get(conv)).toEqual(expected.get(conv));
    const sent = apps.flatMap((a) => a.sent);
    expect(sent).toHaveLength(36);
    expect(new Set(sent.map((s) => s.text)).size).toBe(36);
    expect(await query(setup, sql`select count(*)::int as n from runs where state = 'done'`)).toEqual([{ n: 36 }]);
  });

  it("leaves a run to another instance when shutdown's deadline passes", async () => {
    const setup = t.connect();
    const { app } = testApp({
      execute: async (_run, ctx) => {
        await sleep(60_000, undefined, { signal: ctx.signal });
        return { status: "done", text: "never" };
      },
    });
    const a: Queue = queueOn(t.connect(), app);
    const runId = await enqueue(setup, "c");
    const drained = a.drain();
    await sleep(100);
    await a.shutdown(200);
    await drained;
    const row = await runRow(setup, runId);
    expect(row).toMatchObject({ state: "running", attempt: 1 });
    // The lease wasn't released; once it expires, another instance takes over.
    const b = queueOn(t.connect(), testApp().app);
    expect(await b.claimNext()).toBeNull();
    await expireLease(setup, "c");
    expect((await b.claimNext())!.run).toMatchObject({ id: runId, attempt: 2 });
  });
});
