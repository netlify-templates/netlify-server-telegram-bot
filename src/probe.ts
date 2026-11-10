import { randomUUID, timingSafeEqual } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { getContext } from "@netlify/server";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { kinds, schedulePlanners, senders } from "./app.ts";
import { getDb, rows, transaction } from "./db.ts";
import { INSTANCE_ID } from "./instance.ts";
import { isLiveDeploy } from "./live.ts";
import type { Run, RunContext } from "./queue.ts";
import { getQueue, startDrain } from "./runtime.ts";

// The platform test harness for the run queue (docs/checks.md).
// It's only mounted when PROBE_TOKEN is set, and every route needs the token.
//
// A probe message is a run that takes `seconds`, makes one fenced change half
// way through (recorded in `actions`), and answers on the "probe" channel,
// whose sender logs every send attempt. So after a crash, a deploy or an idle
// stop, /probe/report shows whether each message was answered once (or twice
// with the resend note) and whether its change happened once.

const CONVERSATION = "probe";

let tableReady: Promise<unknown> | undefined;
const ensureTable = () =>
  (tableReady ??= createTable().catch((err) => {
    tableReady = undefined; // try again next time
    throw err;
  }));
const createTable = () =>
  getDb().execute(sql`create table if not exists probe_log (
    id integer primary key generated always as identity,
    run_id integer,
    delivery_id integer,
    key text not null,
    kind text not null,
    text text,
    resend boolean,
    instance text not null,
    at timestamptz not null default now())`);

async function probeRun(run: Run, ctx: RunContext) {
  const seconds = Number(run.input.seconds ?? 10);
  const key = String(run.input.key);
  ctx.emit({ type: "start", instance: INSTANCE_ID, attempt: run.attempt });
  for (let i = 1; i <= seconds; i++) {
    await sleep(1000, undefined, { signal: ctx.signal });
    ctx.emit({ type: "tick", i, of: seconds, instance: INSTANCE_ID });
    if (i === Math.ceil(seconds / 2)) {
      await ensureTable();
      const { replayed } = await ctx.act("probe_effect", async (tx) => {
        await tx.execute(
          sql`insert into probe_log (run_id, key, kind, instance) values (${run.id}, ${key}, 'effect', ${INSTANCE_ID})`,
        );
        return { at: new Date().toISOString() };
      });
      ctx.emit({ type: "tool", name: "probe_effect", replayed });
    }
  }
  const text = `Answer to ${run.input.label ?? key} (run ${run.id}, attempt ${run.attempt}, instance ${INSTANCE_ID})`;
  ctx.emit({ type: "text", text });
  return { status: "done" as const, text };
}

export function registerProbe(): Hono {
  kinds.probe = {
    execute: probeRun,
    route: (_tx, run, text) => [{ channel: "probe", destination: String(run.input.key), text }],
  };
  schedulePlanners.push(async (_tx, s) =>
    s.instruction === "probe"
      ? { kind: "probe", input: { key: `schedule-${s.id}-${randomUUID().slice(0, 8)}`, seconds: s.rule.seconds ?? 10, label: `schedule ${s.id}` }, nextRunAt: null }
      : undefined,
  );
  senders.probe = async (d) => {
    await ensureTable();
    d.signal.throwIfAborted();
    await getDb().execute(
      sql`insert into probe_log (delivery_id, key, kind, text, resend, instance)
          values (${d.id}, ${d.destination}, 'send', ${d.text}, ${d.resend}, ${INSTANCE_ID})`,
    );
  };

  const token = process.env.PROBE_TOKEN ?? "";
  const probe = new Hono();
  probe.use("*", async (c, next) => {
    const given = Buffer.from(c.req.header("x-probe-token") ?? "");
    const expected = Buffer.from(token);
    if (!token || given.length !== expected.length || !timingSafeEqual(given, expected)) return c.notFound();
    await next();
  });

  probe.get("/env", (c) => {
    const ctx = getContext();
    const names = Object.keys(process.env)
      .filter((k) => /^(ANTHROPIC|OPENAI|OPENROUTER|GEMINI|GOOGLE|NETLIFY_AI|NETLIFY_DB)/.test(k))
      .sort();
    return c.json({
      instance: INSTANCE_ID,
      published: ctx.deploy.published,
      context: ctx.deploy.context,
      deployId: ctx.deploy.id,
      region: ctx.server?.region,
      envNames: names,
      dbHost: (() => {
        try {
          return new URL(process.env.NETLIFY_DB_URL ?? "").hostname.replace(/^[^.]+/, "…");
        } catch {
          return null;
        }
      })(),
    });
  });

  probe.post("/message", async (c) => {
    if (!isLiveDeploy()) return c.json({ error: "This isn't the live deploy" }, 409);
    const body = await c.req.json().catch(() => ({}));
    const count = Math.min(Number(body.count ?? 1), 50);
    const out = [];
    const t0 = performance.now();
    for (let i = 0; i < count; i++) {
      const key = body.key && count === 1 ? String(body.key) : randomUUID();
      const label = count > 1 ? `${body.label ?? "probe"} #${i + 1}` : (body.label ?? "probe");
      const r = await getQueue().ingest({
        channel: "probe",
        key,
        conversationId: body.conversation ?? CONVERSATION,
        kind: "probe",
        origin: "probe",
        input: { seconds: body.seconds ?? 10, key, label },
        message: { content: label },
      });
      out.push({ key, ...r });
    }
    const ingestMs = Math.round(performance.now() - t0);
    if (out.some((r) => r.drain)) startDrain();
    return c.json({ instance: INSTANCE_ID, ingestMs, runs: out });
  });

  probe.post("/schedule", async (c) => {
    if (!isLiveDeploy()) return c.json({ error: "This isn't the live deploy" }, 409);
    const body = await c.req.json().catch(() => ({}));
    const db = getDb();
    await db.execute(sql`insert into conversations (id) values (${CONVERSATION}) on conflict do nothing`);
    const [row] = await rows(
      db,
      sql`insert into schedules (conversation_id, instruction, rule, next_run_at)
          values (${CONVERSATION}, 'probe', ${JSON.stringify({ seconds: body.seconds ?? 10 })}::jsonb,
                  now() + make_interval(secs => ${Number(body.inSeconds ?? 60)}))
          returning id, next_run_at`,
    );
    return c.json(row);
  });

  // A hard crash: the instance dies without running any shutdown code.
  probe.post("/crash", (c) => {
    setTimeout(() => process.kill(process.pid, "SIGKILL"), 200);
    return c.json({ instance: INSTANCE_ID, crashing: true, active: getQueue().activeRuns() });
  });

  probe.get("/report", async (c) => {
    await ensureTable();
    const db = getDb();
    const q = (query: ReturnType<typeof sql>) => rows<any>(db, query);
    const runs = await q(sql`
      select r.id, r.kind, r.state, r.attempt, r.error, r.input->>'key' as key, r.input->>'label' as label,
             r.created_at, r.started_at, r.finished_at,
             (select count(*)::int from probe_log l where l.key = r.input->>'key' and l.kind = 'effect') as effects,
             (select count(*)::int from actions a where a.run_id = r.id) as actions,
             (select coalesce(json_agg(json_build_object('resend', l.resend, 'instance', l.instance, 'at', l.at, 'text', l.text) order by l.id), '[]')
                from probe_log l where l.key = r.input->>'key' and l.kind = 'send') as sends,
             (select coalesce(json_agg(json_build_object('state', d.state, 'attempt', d.attempt, 'error', d.last_error) order by d.id), '[]')
                from deliveries d where d.run_id = r.id) as deliveries
      from runs r where r.conversation_id = ${c.req.query("conversation") ?? CONVERSATION}
      order by r.id desc limit ${Number(c.req.query("limit") ?? 50)}`);
    const [conv] = await q(
      sql`select holder_token is not null as held, lease_until, now() as now from conversations where id = ${CONVERSATION}`,
    );
    const schedules = await q(sql`select id, next_run_at, paused from schedules where conversation_id = ${CONVERSATION} order by id desc limit 10`);
    return c.json({ instance: INSTANCE_ID, active: getQueue().activeRuns(), conversation: conv ?? null, schedules, runs });
  });

  probe.post("/reset", async (c) => {
    if (!isLiveDeploy()) return c.json({ error: "This isn't the live deploy" }, 409);
    const db = getDb();
    await ensureTable();
    await transaction(db, async (tx) => {
      const ids = sql`(select id from runs where conversation_id like 'probe%')`;
      await tx.execute(sql`delete from probe_log`);
      await tx.execute(sql`delete from actions where run_id in ${ids}`);
      await tx.execute(sql`delete from deliveries where run_id in ${ids} or channel = 'probe'`);
      await tx.execute(sql`delete from inbound where channel = 'probe'`);
      await tx.execute(sql`delete from messages where conversation_id like 'probe%'`);
      await tx.execute(sql`delete from runs where conversation_id like 'probe%'`);
      await tx.execute(sql`delete from schedules where conversation_id like 'probe%'`);
      await tx.execute(sql`update conversations set holder_token = null, lease_until = null where id like 'probe%'`);
    });
    return c.json({ reset: true });
  });

  return probe;
}
