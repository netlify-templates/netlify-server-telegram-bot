import { randomUUID } from "node:crypto";
import { getContext } from "@netlify/server";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { CONVERSATION, isCommand } from "./assistant.ts";
import { attemptLogin, checkSession, COOKIE, consoleState, makeSession } from "./auth.ts";
import { createPairingLink, ensureWebhook, telegramConfigured, telegramStatus } from "./channels/telegram.ts";
import { getDb, rows, transaction } from "./db.ts";
import { subscribe } from "./events.ts";
import { INSTANCE_ID, BUILD_ID } from "./instance.ts";
import { isLiveDeploy } from "./live.ts";
import { PERSONAS, personaById } from "./personas.ts";
import { insertRun } from "./queue.ts";
import { getQueue, startDrain } from "./runtime.ts";
import { getSettings, isValidTimezone, MODELS, setSetting } from "./settings.ts";
import { spendSummary } from "./spend.ts";
import { localDay, nextRun, type Rule, ruleText } from "./time.ts";
import { changeTimezone } from "./tools/identity.ts";
import { noteProblem, NOTES_TOTAL } from "./tools/memory.ts";
import { MAX_SCHEDULES } from "./tools/schedules.ts";

// The console's JSON API. The contract is in docs/console-api.md.

const api = new Hono();
const openStreams = new Set<() => void>();
/** Ends every open stream, so clients reconnect to the next instance. Called at shutdown. */
export const closeStreams = () => openStreams.forEach((close) => close());

const notLive = { error: "This isn't the live deploy." };

api.get("/session", async (c) => {
  const state = consoleState();
  const signedIn = state.enabled && (await checkSession(getDb(), getCookie(c, COOKIE)));
  return c.json({ signedIn, consoleEnabled: state.enabled, reason: state.reason });
});

api.post("/login", async (c) => {
  const state = consoleState();
  if (!state.enabled) return c.json({ error: state.reason }, 503);
  if (!isLiveDeploy()) return c.json(notLive, 409);
  const { password } = await c.req.json().catch(() => ({ password: "" }));
  const result = await attemptLogin(getDb(), String(password ?? ""));
  if (!result.ok) {
    if (result.retryAfter) {
      c.header("retry-after", String(result.retryAfter));
      return c.json({ error: "Too many attempts. Wait a little and try again.", retryAfter: result.retryAfter }, 429);
    }
    return c.json({ error: "That's not the password." }, 401);
  }
  const session = await makeSession(getDb());
  setCookie(c, COOKIE, session.value, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: session.maxAge });
  return c.json({ ok: true });
});

api.post("/logout", (c) => {
  deleteCookie(c, COOKIE, { path: "/" });
  return c.json({ ok: true });
});

// Everything below needs a session. Changes also need the live deploy.
api.use("*", async (c, next) => {
  const state = consoleState();
  if (!state.enabled) return c.json({ error: state.reason }, 503);
  const probe = process.env.PROBE_TOKEN && c.req.header("x-probe-token") === process.env.PROBE_TOKEN;
  if (!probe && !(await checkSession(getDb(), getCookie(c, COOKIE)))) return c.json({ error: "Signed out." }, 401);
  if (c.req.method !== "GET" && !isLiveDeploy()) return c.json(notLive, 409);
  c.header("cache-control", "no-store");
  await next();
});

// ---- Chat ------------------------------------------------------------------

api.get("/messages", async (c) => {
  const before = Number(c.req.query("before")) || null;
  const after = Number(c.req.query("after")) || null;
  const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
  const list = await rows<{ id: number; role: string; content: string; created_at: string; run_id: number | null; meta: any }>(
    getDb(),
    sql`select id, role, content, created_at, run_id, meta from messages
        where conversation_id = ${CONVERSATION}
          and (${before}::int is null or id < ${before}::int) and (${after}::int is null or id > ${after}::int)
        order by id ${after ? sql`asc` : sql`desc`} limit ${limit + 1}`,
  );
  const hasMore = list.length > limit;
  const page = list.slice(0, limit);
  if (!after) page.reverse();
  return c.json({
    hasMore,
    messages: page.map((m) => ({ id: m.id, role: m.role, content: m.content, createdAt: m.created_at, runId: m.run_id, meta: m.meta })),
  });
});

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

api.post("/chat", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const text = String(body.text ?? "").trim();
  const image = body.image;
  if (!text && !image) return c.json({ error: "Write something first." }, 400);
  if (image && (!IMAGE_TYPES.includes(image.mediaType) || typeof image.data !== "string")) return c.json({ error: "That photo type isn't supported." }, 400);
  if (image && image.data.length > 7_000_000) return c.json({ error: "Photos can be up to 5 MB." }, 413);
  const command = !image && isCommand(text);
  const r = await getQueue().ingest({
    channel: "console",
    key: String(body.clientId || randomUUID()),
    conversationId: CONVERSATION,
    kind: command ? "command" : "message",
    origin: "console",
    input: command ? { text } : { text, image },
    message: { content: text || "(photo)", meta: image ? { photo: true } : undefined },
  });
  if (r.drain) startDrain();
  return c.json({ runId: r.runId }, 202);
});

// A run's progress as server-sent events. The instance running it streams each
// event; any other instance (after a deploy, say) polls the database and sends
// the finished answer.
api.get("/runs/:id/events", (c) => {
  const runId = Number(c.req.param("id"));
  const db = getDb();
  return streamSSE(c, async (stream) => {
    let closed = false;
    const close = () => {
      closed = true;
      stream.close();
    };
    openStreams.add(close);
    stream.onAbort(() => {
      closed = true;
    });
    await stream.writeSSE({ event: "hello", data: JSON.stringify({ instance: INSTANCE_ID }) });
    const unsubscribe = subscribe(runId, c.req.header("last-event-id"), (e) => {
      if (!closed && e.event.type !== "done" && e.event.type !== "failed") {
        stream.writeSSE({ id: e.id, event: e.event.type, data: JSON.stringify(e.event) }).catch(() => {});
      }
    });
    try {
      let lastPing = Date.now();
      while (!closed) {
        const [run] = await rows<{ state: string; reply: string | null }>(
          db,
          sql`select state, (select content from messages m where m.run_id = r.id and m.role in ('assistant', 'notice')
                             order by id desc limit 1) as reply
              from runs r where id = ${runId}`,
        );
        if (!run) {
          await stream.writeSSE({ event: "missing", data: "{}" });
          break;
        }
        if (run.state === "done" || run.state === "failed") {
          await stream.writeSSE({ event: run.state, data: JSON.stringify({ text: run.reply ?? "" }) });
          break;
        }
        if (Date.now() - lastPing > 15_000) {
          await stream.write(": ping\n\n");
          lastPing = Date.now();
        }
        await stream.sleep(1000);
      }
    } finally {
      unsubscribe();
      openStreams.delete(close);
    }
  });
});

// ---- Proposals -------------------------------------------------------------

api.get("/proposals", async (c) => {
  const list = await rows(
    getDb(),
    sql`select id, summary, created_at as "createdAt", expires_at as "expiresAt" from proposals
        where state = 'pending' and expires_at > now() order by id`,
  );
  return c.json({ proposals: list });
});

api.post("/proposals/:id", async (c) => {
  const { decision } = await c.req.json().catch(() => ({}));
  if (decision !== "confirm" && decision !== "discard") return c.json({ error: "decision must be confirm or discard" }, 400);
  const id = Number(c.req.param("id"));
  const r = await getQueue().ingest({
    channel: "console",
    key: `proposal:${id}:${decision}`,
    conversationId: CONVERSATION,
    kind: "proposal",
    origin: "console",
    input: { proposalId: id, decision },
  });
  if (r.drain) startDrain();
  return c.json({ runId: r.runId }, 202);
});

// ---- Memory ----------------------------------------------------------------

api.get("/notes", async (c) => {
  const notes = await rows<{ id: number; content: string; updatedAt: string }>(getDb(), sql`select id, content, updated_at as "updatedAt" from notes order by id`);
  return c.json({ notes, used: notes.reduce((n, x) => n + x.content.length, 0), limit: NOTES_TOTAL });
});

api.post("/notes", async (c) => {
  const content = String((await c.req.json().catch(() => ({}))).content ?? "").trim();
  const problem = await noteProblem(getDb(), content);
  if (problem) return c.json({ error: problem }, 400);
  const [note] = await rows(getDb(), sql`insert into notes (content) values (${content}) returning id, content, updated_at as "updatedAt"`);
  return c.json({ note });
});

api.put("/notes/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const content = String((await c.req.json().catch(() => ({}))).content ?? "").trim();
  const problem = await noteProblem(getDb(), content, id);
  if (problem) return c.json({ error: problem }, 400);
  const [note] = await rows(getDb(), sql`update notes set content = ${content}, updated_at = now() where id = ${id} returning id, content, updated_at as "updatedAt"`);
  return note ? c.json({ note }) : c.json({ error: "No such note." }, 404);
});

api.delete("/notes/:id", async (c) => {
  await getDb().execute(sql`delete from notes where id = ${Number(c.req.param("id"))}`);
  return c.json({ ok: true });
});

// ---- Schedules -------------------------------------------------------------

const TEMPLATES = [
  {
    id: "morning-brief",
    title: "Morning brief",
    description: "Weekdays at 08:00: the weather, and headlines on topics you pick.",
    fields: [
      { name: "city", label: "City", placeholder: "Lisbon", required: true },
      { name: "topics", label: "Topics", placeholder: "AI, climbing, local news", required: true },
    ],
  },
  {
    id: "watch-page",
    title: "Watch a page",
    description: "Every 3 hours, tells you only when the page changed.",
    fields: [
      { name: "url", label: "Page URL", placeholder: "https://example.com/pricing", required: true },
      { name: "what", label: "What to look for", placeholder: "the price of the Pro plan", required: false },
    ],
  },
  {
    id: "site-down",
    title: "Tell me if my site is down",
    description: "Every hour, speaks up only when your site stops (or starts) answering.",
    fields: [{ name: "url", label: "Site URL", placeholder: "https://example.com", required: true }],
  },
];

const isUrl = (s: string) => /^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(s);

/** Builds a starter schedule. The brief's forecast URL is resolved here, so the scheduled run can fetch it. */
async function fromTemplate(id: string, f: Record<string, string>): Promise<{ instruction: string; mode: string; rule: Rule } | string> {
  if (id === "morning-brief") {
    if (!f.city || !f.topics) return "Give a city and some topics.";
    const geo = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(f.city)}&count=1`, {
      signal: AbortSignal.timeout(8_000),
    }).then((r) => r.json() as Promise<{ results?: { latitude: number; longitude: number; name: string; country?: string }[] }>);
    const place = geo.results?.[0];
    if (!place) return `I couldn't find a place called ${f.city}.`;
    const forecast = `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=1`;
    return {
      instruction: `Morning brief for ${place.name}${place.country ? `, ${place.country}` : ""}. Fetch today's forecast from ${forecast} and summarize it in one line. Then search for today's top news on: ${f.topics}, and list 3 to 5 headlines with a short line each and a link.`,
      mode: "notify",
      rule: { kind: "daily", time: "08:00", weekdays: [1, 2, 3, 4, 5] },
    };
  }
  if (id === "watch-page") {
    if (!isUrl(f.url ?? "")) return "Give the page's full URL, starting with https://.";
    return {
      instruction: `Fetch ${f.url}${f.what ? ` and look at ${f.what}` : ""}. Report what changed since your previous report.`,
      mode: "watch",
      rule: { kind: "every", hours: 3, anchor: new Date().toISOString() },
    };
  }
  if (id === "site-down") {
    if (!isUrl(f.url ?? "")) return "Give the site's full URL, starting with https://.";
    return {
      instruction: `Fetch ${f.url}. Say whether it loads normally, and if it doesn't, what you saw (an error, a timeout, a wrong page).`,
      mode: "watch",
      rule: { kind: "every", hours: 1, anchor: new Date().toISOString() },
    };
  }
  return "Unknown template.";
}

const scheduleJson = (s: any, tz: string) => ({
  id: s.id,
  instruction: s.instruction,
  mode: s.mode,
  rule: s.rule,
  ruleText: ruleText(s.rule, tz),
  nextRunAt: s.next_run_at,
  paused: s.paused,
  failures: s.failures,
  lastReport: s.last_report,
});

api.get("/schedules", async (c) => {
  const db = getDb();
  const { timezone } = await getSettings(db);
  const list = await rows(db, sql`select * from schedules where conversation_id = ${CONVERSATION} order by id`);
  return c.json({ schedules: list.map((s) => scheduleJson(s, timezone)), limit: MAX_SCHEDULES, templates: TEMPLATES });
});

api.post("/schedules", async (c) => {
  const { template, fields } = await c.req.json().catch(() => ({}));
  const db = getDb();
  const { timezone } = await getSettings(db);
  const [{ n }] = await rows<{ n: number }>(db, sql`select count(*)::int as n from schedules where conversation_id = ${CONVERSATION}`);
  if (n >= MAX_SCHEDULES) return c.json({ error: `There are already ${MAX_SCHEDULES} schedules.` }, 400);
  const plan = await fromTemplate(String(template), fields ?? {}).catch(() => "I couldn't look that up just now. Try again?");
  if (typeof plan === "string") return c.json({ error: plan }, 400);
  await db.execute(sql`insert into conversations (id) values (${CONVERSATION}) on conflict do nothing`);
  const [s] = await rows(
    db,
    sql`insert into schedules (conversation_id, instruction, mode, rule, next_run_at)
        values (${CONVERSATION}, ${plan.instruction}, ${plan.mode}, ${JSON.stringify(plan.rule)}::jsonb, ${nextRun(plan.rule, new Date(), timezone)})
        returning *`,
  );
  return c.json({ schedule: scheduleJson(s, timezone) });
});

api.patch("/schedules/:id", async (c) => {
  const { paused } = await c.req.json().catch(() => ({}));
  const db = getDb();
  const { timezone } = await getSettings(db);
  const [current] = await rows<{ rule: Rule }>(db, sql`select rule from schedules where id = ${Number(c.req.param("id"))}`);
  if (!current) return c.json({ error: "No such schedule." }, 404);
  // Resuming starts from the next time after now, not from a missed one.
  const next = paused ? null : nextRun(current.rule, new Date(), timezone);
  const [s] = await rows(
    db,
    sql`update schedules set paused = ${Boolean(paused)}, failures = 0, next_run_at = coalesce(${next}, next_run_at), updated_at = now()
        where id = ${Number(c.req.param("id"))} returning *`,
  );
  return c.json({ schedule: scheduleJson(s, timezone) });
});

api.delete("/schedules/:id", async (c) => {
  await getDb().execute(sql`delete from schedules where id = ${Number(c.req.param("id"))} and conversation_id = ${CONVERSATION}`);
  return c.json({ ok: true });
});

api.post("/schedules/:id/run", async (c) => {
  const db = getDb();
  const [s] = await rows(db, sql`select * from schedules where id = ${Number(c.req.param("id"))} and conversation_id = ${CONVERSATION}`);
  if (!s) return c.json({ error: "No such schedule." }, 404);
  const runId = await insertRun(db, {
    conversationId: CONVERSATION,
    kind: "schedule",
    origin: "schedule",
    // "Run now" runs even a paused schedule.
    input: { scheduleId: s.id, instruction: s.instruction, mode: s.mode, manual: true },
  });
  startDrain();
  return c.json({ runId }, 202);
});

// ---- Settings --------------------------------------------------------------

const settingsJson = async () => {
  const s = await getSettings(getDb());
  return {
    timezone: s.timezone,
    model: s.model,
    models: MODELS,
    dailyCapUsd: s.dailyCapUsd,
    persona: s.persona,
    presets: PERSONAS.map(({ id, name, description }) => ({ id, name, description })),
  };
};

api.get("/settings", async (c) => c.json(await settingsJson()));

api.put("/settings", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const db = getDb();
  if (body.timezone !== undefined && !isValidTimezone(String(body.timezone))) return c.json({ error: "That isn't a time zone I know." }, 400);
  if (body.model !== undefined && !MODELS.some((m) => m.id === body.model)) return c.json({ error: "Unknown model." }, 400);
  const cap = body.dailyCapUsd === undefined ? undefined : Number(body.dailyCapUsd);
  if (cap !== undefined && !(cap >= 0 && cap <= 100)) return c.json({ error: "The daily cap must be between $0 and $100." }, 400);
  await transaction(db, async (tx) => {
    if (body.timezone !== undefined) await changeTimezone(tx, body.timezone);
    if (body.model !== undefined) await setSetting(tx, "model", body.model);
    if (cap !== undefined) await setSetting(tx, "daily_cap_usd", cap);
    if (body.persona) {
      const current = await getSettings(tx);
      const preset = personaById(body.persona.preset ?? current.persona.preset);
      // Picking another preset takes its name and soul unless new ones are given.
      const switched = preset.id !== current.persona.preset;
      await setSetting(tx, "persona", {
        preset: preset.id,
        name: String(body.persona.name ?? (switched ? "" : current.persona.name)).slice(0, 40) || preset.name,
        soul: String(body.persona.soul ?? (switched ? "" : current.persona.soul)).slice(0, 2_000) || preset.soul,
      });
    }
  });
  return c.json(await settingsJson());
});

// ---- Status ----------------------------------------------------------------

api.get("/status", async (c) => {
  const db = getDb();
  const s = await getSettings(db);
  const siteUrl = getContext().site.url ?? new URL(c.req.url).origin;
  // Opening the console after setting the token is what connects the bot.
  const connectError = isLiveDeploy()
    ? await ensureWebhook(db, siteUrl).then(
        () => null,
        (err) => (err instanceof Error ? err.message : String(err)),
      )
    : null;
  const telegram = await telegramStatus(db, siteUrl);
  const [counts] = await rows(
    db,
    sql`select count(*) filter (where state = 'queued')::int as queued,
               count(*) filter (where state = 'running')::int as running,
               count(*) filter (where state = 'failed' and finished_at > now() - interval '1 day')::int as "failedToday"
        from runs where conversation_id = ${CONVERSATION}`,
  );
  const [wake] = await rows<{ at: string }>(db, sql`select value #>> '{}' as at from settings where key = 'wake_last'`);
  const failed = await rows(
    db,
    sql`select id, text, last_error as "lastError", created_at as "createdAt" from deliveries where state = 'failed' order by id desc limit 20`,
  );
  return c.json({
    build: BUILD_ID,
    instance: INSTANCE_ID,
    telegram: { ...telegram, lastError: telegram.lastError ?? connectError },
    wake: { lastCallAt: wake?.at ?? null },
    spend: { ...(await spendSummary(db, localDay(new Date(), s.timezone))), cap: s.dailyCapUsd },
    runs: counts,
    deliveries: { failed },
  });
});

api.post("/deliveries/:id/retry", async (c) => {
  const ok = await getQueue().retryDelivery(Number(c.req.param("id")));
  if (ok) startDrain();
  return c.json({ ok });
});

api.post("/telegram/pair", async (c) => {
  if (!telegramConfigured()) return c.json({ error: "Set TELEGRAM_BOT_TOKEN in the site's environment variables first." }, 400);
  const db = getDb();
  await ensureWebhook(db, getContext().site.url ?? new URL(c.req.url).origin);
  return c.json(await createPairingLink(db));
});

api.post("/telegram/webhook", async (c) => {
  if (!telegramConfigured()) return c.json({ error: "Set TELEGRAM_BOT_TOKEN in the site's environment variables first." }, 400);
  const url = await ensureWebhook(getDb(), getContext().site.url ?? new URL(c.req.url).origin, { force: true });
  return c.json({ ok: true, url });
});

export default api;
