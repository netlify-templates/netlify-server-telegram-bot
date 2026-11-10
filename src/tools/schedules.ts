import { sql } from "drizzle-orm";
import { formatLocal, nextRun, parseLocalDateTime, parseWeekdays, type Rule, ruleText } from "../time.ts";
import type { ChangeTool, ReadTool, ToolContext } from "./types.ts";
import { rows } from "../db.ts";

// Reminders and recurring jobs in the owner's local time. At most 10.

export const MAX_SCHEDULES = 10;

export interface ScheduleInput {
  instruction: string;
  mode: "notify" | "watch";
  kind: "at" | "daily" | "every";
  at?: string;
  time?: string;
  weekdays?: string[];
  every_hours?: number;
}

/** Turns the tool's input into a stored rule, or an error message. */
export function toRule(input: ScheduleInput, tz: string, now = new Date()): Rule | string {
  if (input.kind === "at") {
    const at = input.at ? parseLocalDateTime(input.at, tz) : null;
    if (!at) return 'For a one-off, give "at" as a local time like 2026-11-10T09:00.';
    if (at.getTime() < now.getTime() - 60_000) return "That time has already passed.";
    return { kind: "at", at: at.toISOString() };
  }
  if (input.kind === "daily") {
    if (!input.time || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) return 'For a daily schedule, give "time" as HH:MM.';
    try {
      return { kind: "daily", time: input.time, weekdays: parseWeekdays(input.weekdays) };
    } catch (err) {
      return (err as Error).message;
    }
  }
  if (input.kind === "every") {
    const hours = Number(input.every_hours);
    if (!Number.isInteger(hours) || hours < 1 || hours > 168) return '"every_hours" must be a whole number from 1 to 168.';
    return { kind: "every", hours, anchor: now.toISOString() };
  }
  return 'kind must be "at", "daily" or "every".';
}

export const schedule: ChangeTool = {
  kind: "change",
  label: "Scheduling",
  definition: {
    name: "schedule",
    description:
      "Schedule a reminder or a recurring job. When it's due you'll be woken with `instruction`, and what you write is sent to the owner. Times are in the owner's time zone. Use mode \"watch\" for jobs that should only speak when something changed (a price, a page, a site being down); you'll get your previous report and can answer NOTHING_NEW. Scheduled runs can read, search and fetch, but can't change memory or schedules.",
    input_schema: {
      type: "object",
      properties: {
        instruction: { type: "string", description: "What to do when it's due, as an instruction to yourself. Include any URL it needs." },
        mode: { type: "string", enum: ["notify", "watch"] },
        kind: { type: "string", enum: ["at", "daily", "every"], description: "Once, daily at a time, or every N hours." },
        at: { type: "string", description: 'For "at": local date and time, YYYY-MM-DDTHH:MM.' },
        time: { type: "string", description: 'For "daily": local time, HH:MM.' },
        weekdays: { type: "array", items: { type: "string" }, description: 'For "daily", optional: days like ["mon","wed"], or ["weekdays"].' },
        every_hours: { type: "integer", description: 'For "every": hours between runs, at least 1.' },
      },
      required: ["instruction", "mode", "kind"],
      additionalProperties: false,
    },
  },
  async check(input: ScheduleInput, { db, settings }) {
    if (!input.instruction?.trim()) return "The instruction can't be empty.";
    const [{ n }] = await rows<{ n: number }>(db, sql`select count(*)::int as n from schedules where conversation_id <> 'probe'`);
    if (n >= MAX_SCHEDULES) return `There are already ${MAX_SCHEDULES} schedules, the most allowed. Cancel one first.`;
    const rule = toRule(input, settings.timezone);
    return typeof rule === "string" ? rule : null;
  },
  describe: (input: ScheduleInput, { settings }) => {
    const rule = toRule(input, settings.timezone);
    return `Schedule${input.mode === "watch" ? " a watch" : ""} ${typeof rule === "string" ? "" : ruleText(rule, settings.timezone)}: ${input.instruction.trim()}`;
  },
  async apply(tx, input: ScheduleInput, { settings, conversationId }) {
    const rule = toRule(input, settings.timezone);
    if (typeof rule === "string") throw new Error(rule);
    const next = rule.kind === "at" ? new Date(rule.at) : nextRun(rule, new Date(), settings.timezone);
    const [s] = await rows<{ id: number }>(
      tx,
      sql`insert into schedules (conversation_id, instruction, mode, rule, next_run_at)
          values (${conversationId}, ${input.instruction.trim()}, ${input.mode}, ${JSON.stringify(rule)}::jsonb, ${next})
          returning id`,
    );
    const when = ruleText(rule, settings.timezone);
    const nextText = next ? `, next ${formatLocal(next, settings.timezone)}` : "";
    return {
      text: `Scheduled as ${s.id}: ${when}${nextText}.`,
      notice: `⏰ Scheduled ${when.charAt(0).toLowerCase() + when.slice(1)}: ${input.instruction.trim()} (/cancel ${s.id})`,
    };
  },
};

export const cancelSchedule: ChangeTool = {
  kind: "change",
  label: "Cancelling a schedule",
  definition: {
    name: "cancel_schedule",
    description: "Cancel a reminder or recurring job by id.",
    input_schema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"], additionalProperties: false },
    strict: true,
  },
  async check({ id }, { db }) {
    const [s] = await rows(db, sql`select id from schedules where id = ${Number(id)} and conversation_id <> 'probe'`);
    return s ? null : `There's no schedule ${id}.`;
  },
  describe: ({ id }) => `Cancel schedule ${id}`,
  async apply(tx, { id }) {
    const [s] = await rows<{ instruction: string }>(tx, sql`delete from schedules where id = ${Number(id)} returning instruction`);
    if (!s) throw new Error(`There's no schedule ${id}.`);
    return { text: `Schedule ${id} cancelled.`, notice: `🛑 Cancelled schedule ${id}: ${s.instruction}` };
  },
};

export async function describeSchedules(tc: Pick<ToolContext, "db" | "settings">): Promise<string> {
  const list = await rows<{ id: number; instruction: string; mode: string; rule: Rule; next_run_at: string | null; paused: boolean }>(
    tc.db,
    sql`select id, instruction, mode, rule, next_run_at, paused from schedules where conversation_id <> 'probe' order by id`,
  );
  if (list.length === 0) return "No schedules.";
  const tz = tc.settings.timezone;
  return list
    .map(
      (s) =>
        `${s.id}: ${ruleText(s.rule, tz)}${s.mode === "watch" ? " (watch)" : ""}${s.paused ? " (paused)" : s.next_run_at ? `, next ${formatLocal(new Date(s.next_run_at), tz)}` : ""}: ${s.instruction}`,
    )
    .join("\n");
}

export const listSchedules: ReadTool = {
  kind: "read",
  label: "Checking schedules",
  definition: {
    name: "list_schedules",
    description: "List the reminders and recurring jobs.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  run: (_input, tc) => describeSchedules(tc),
};
