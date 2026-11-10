import { sql } from "drizzle-orm";
import { runAgent } from "./agent.ts";
import { kinds, routing, schedulePlanners, senders } from "./app.ts";
import { downloadPhoto, keepTyping, telegramSender } from "./channels/telegram.ts";
import { getDb, rowCount, rows, type Tx } from "./db.ts";
import type { Action, NewDelivery, Outcome, Run } from "./queue.ts";
import { getSettings } from "./settings.ts";
import { planOccurrence, type Rule, ruleText } from "./time.ts";
import { toolByName } from "./tools/index.ts";
import { forget } from "./tools/memory.ts";
import { cancelSchedule } from "./tools/schedules.ts";
import type { ChangeTool, ToolContext } from "./tools/types.ts";

// The run kinds the assistant has, and where their replies go. One owner, one
// conversation across Telegram and the console.

export const CONVERSATION = "main";

export const HELP = `Here's what I can do. Just talk to me: I remember things, set reminders and recurring jobs ("every weekday at 8, send me the weather"), watch pages for changes, search the web and look at photos.

/new starts a fresh conversation (I keep my memory)
/forget <id> removes a note
/cancel <id> cancels a schedule
/help shows this

Everything else is in the web console: memory, schedules, spend and settings.`;

const done = (text: string): Outcome => ({ status: "done", text });

const COMMANDS = ["/new", "/forget", "/cancel", "/help", "/start"];
export const isCommand = (text: string) => COMMANDS.includes(text.trim().split(/\s+/)[0]?.toLowerCase().replace(/@\w+$/, ""));

/**
 * Where a reply goes. Console runs need no delivery: the console reads
 * `messages`. Everything else goes to the owner's paired Telegram chat, and
 * only there, once Telegram is paired. Proposals get Confirm and Discard buttons.
 */
async function route(tx: Tx, run: Run, text: string, actions: Action[] = []): Promise<NewDelivery[]> {
  if (run.origin === "console") return [];
  const s = await getSettings(tx);
  if (!s.telegram) return [];
  const chat = String(s.telegram.chatId);
  const out: NewDelivery[] = text ? [{ channel: "telegram", destination: chat, text }] : [];
  for (const a of actions.filter((x) => x.kind === "propose")) {
    out.push({
      channel: "telegram",
      destination: chat,
      text: `💡 ${a.result.summary}\n\nI read outside text before suggesting this, so it's your call.`,
      meta: {
        buttons: [
          { text: "Confirm", data: `p:${a.result.proposalId}:confirm` },
          { text: "Discard", data: `p:${a.result.proposalId}:discard` },
        ],
      },
    });
  }
  return out;
}

async function storeReply(tx: Tx, run: Run, role: "assistant" | "notice", text: string, meta?: unknown) {
  await tx.execute(
    sql`insert into messages (conversation_id, run_id, role, content, meta)
        values (${run.conversationId}, ${run.id}, ${role}, ${text}, ${JSON.stringify(meta ?? null)}::jsonb)`,
  );
}

const toolContext = async (run: Run): Promise<ToolContext> => {
  const db = getDb();
  return { db, settings: await getSettings(db), conversationId: run.conversationId, runId: run.id };
};

export function registerAssistant(): void {
  routing.route = route;
  senders.telegram = telegramSender;
  // The console reads `messages`, so a delivery to it is done once stored.
  senders.console = async () => {};

  kinds.message = {
    async execute(run, ctx) {
      const input = run.input as { text: string; image?: any; photoFileId?: string; forwarded?: boolean };
      const channel = run.origin === "telegram" ? "telegram" : "console";
      const owner = channel === "telegram" ? (await getSettings(getDb())).telegram : null;
      const stopTyping = owner ? keepTyping(owner.chatId) : () => {};
      try {
        const image = input.image ?? (input.photoFileId ? await downloadPhoto(input.photoFileId) : undefined);
        return await runAgent({ run, ctx, mode: "live", text: input.text, image, channel, forwarded: input.forwarded });
      } finally {
        stopTyping();
      }
    },
  };

  kinds.schedule = {
    async execute(run, ctx) {
      const input = run.input as { scheduleId: number; manual?: boolean };
      // The schedule as it is now: it may have been cancelled or paused since
      // this run was queued (a run deferred to midnight, say), and a watch
      // compares against the latest report.
      const [s] = await rows<{ instruction: string; mode: string; paused: boolean; last_report: string | null }>(
        getDb(),
        sql`select instruction, mode, paused, last_report from schedules where id = ${input.scheduleId}`,
      );
      if (!s || (s.paused && !input.manual)) return { status: "done", text: "", result: { skipped: true } };
      return runAgent({
        run,
        ctx,
        mode: "scheduled",
        text: s.instruction,
        channel: "schedule",
        watch: s.mode === "watch" ? { lastReport: s.last_report } : undefined,
      });
    },
    async complete(tx, run, outcome) {
      if ((outcome.result as { skipped?: boolean } | undefined)?.skipped) return [];
      const { scheduleId, mode } = run.input as { scheduleId: number; mode: string };
      // A watch that found nothing new stays silent.
      if (mode === "watch" && /^NOTHING_NEW\b/i.test(outcome.text.trim())) {
        await tx.execute(sql`update schedules set failures = 0 where id = ${scheduleId}`);
        return [];
      }
      await tx.execute(sql`update schedules set failures = 0, last_report = ${outcome.text} where id = ${scheduleId}`);
      await storeReply(tx, run, "assistant", outcome.text, { scheduleId });
      return route(tx, run, outcome.text);
    },
    async fail(tx, run) {
      const { scheduleId, instruction } = run.input as { scheduleId: number; instruction: string };
      // Three failures in a row pause the schedule.
      const [s] = await rows<{ paused: boolean }>(
        tx,
        sql`update schedules set failures = failures + 1, paused = paused or failures + 1 >= 3 where id = ${scheduleId} returning paused`,
      );
      const text = s?.paused
        ? `Schedule ${scheduleId} failed 3 times in a row, so I paused it: ${instruction}`
        : `I couldn't run schedule ${scheduleId} this time: ${instruction}`;
      await storeReply(tx, run, "notice", text, { scheduleId });
      return route(tx, run, text);
    },
  };

  kinds.command = {
    async execute(run, ctx) {
      const [raw, ...rest] = String(run.input.text ?? "").trim().split(/\s+/);
      const cmd = raw.toLowerCase().replace(/@\w+$/, "");
      const arg = rest.join(" ").replace("#", "");
      if (cmd === "/forget" || cmd === "/cancel") {
        const tool: ChangeTool = cmd === "/forget" ? forget : cancelSchedule;
        const id = Number(arg);
        if (!arg || !Number.isInteger(id)) return done(`Usage: ${cmd} <id>`);
        const tc = await toolContext(run);
        const problem = await tool.check({ id }, tc);
        if (problem) return done(problem);
        await ctx.act(tool.definition.name, (tx) => tool.apply(tx, { id }, tc));
        return done(""); // the server's notice is the reply
      }
      if (cmd === "/new") {
        await ctx.act("reset", async (tx) => {
          await tx.execute(
            sql`insert into messages (conversation_id, run_id, role, content, meta)
                values (${run.conversationId}, ${run.id}, 'notice', 'New conversation', '{"reset": true}'::jsonb)`,
          );
          return { notice: "🆕 Fresh start. I kept my memory and schedules." };
        });
        return done("");
      }
      if (cmd === "/unsupported") return done("I can read text and photos for now.");
      return done(HELP);
    },
  };

  // The owner's answer to a proposal, from a Telegram button or the console.
  kinds.proposal = {
    async execute(run, ctx) {
      const { proposalId, decision } = run.input as { proposalId: number; decision: "confirm" | "discard" };
      const [p] = await rows<{ tool: string; input: any; summary: string; state: string; expired: boolean }>(
        getDb(),
        sql`select tool, input, summary, state, expires_at < now() as expired from proposals where id = ${proposalId}`,
      );
      if (!p || p.state !== "pending" || p.expired) return done(`That suggestion isn't waiting for an answer anymore.`);
      const decide = async (tx: Tx, state: string) => {
        const changed = await rowCount(tx, sql`update proposals set state = ${state}, decided_at = now() where id = ${proposalId} and state = 'pending'`);
        if (changed !== 1) throw new Error("That suggestion was already answered.");
      };
      if (decision === "discard") {
        await ctx.act("discard_proposal", async (tx) => {
          await decide(tx, "discarded");
          return { notice: `🚫 Discarded: ${p.summary}` };
        });
        return done("");
      }
      const tool = toolByName(p.tool);
      if (!tool || tool.kind !== "change") return done("I don't know how to apply that anymore.");
      const tc = await toolContext(run);
      const problem = await tool.check(p.input, tc);
      if (problem) return done(`I couldn't apply it: ${problem}`);
      await ctx.act(tool.definition.name, async (tx) => {
        await decide(tx, "confirmed");
        return tool.apply(tx, p.input, tc);
      });
      return done("");
    },
  };

  // Turns a due schedule into a run, or skips an occurrence that's 6 hours late or more.
  schedulePlanners.push(async (tx, s, now) => {
    if (s.conversationId.startsWith("probe")) return undefined;
    const settings = await getSettings(tx);
    const rule = s.rule as Rule;
    const plan = planOccurrence(rule, s.nextRunAt, now, settings.timezone);
    if (plan.run) {
      return { input: { scheduleId: s.id, instruction: s.instruction, mode: s.mode }, nextRunAt: plan.next };
    }
    const hours = Math.round(plan.lateMs / 3600_000);
    const message = `I skipped schedule ${s.id} (${ruleText(rule, settings.timezone)}) because it came up ${hours} hours late: ${s.instruction}`;
    const chat = settings.telegram ? String(settings.telegram.chatId) : null;
    return {
      notice: { channel: chat ? "telegram" : "console", destination: chat ?? "console", text: message, message },
      nextRunAt: plan.next,
    };
  });
}
