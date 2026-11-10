import { sql } from "drizzle-orm";
import type { Tx } from "./db.ts";
import type { Action, NewDelivery, Outcome, QueueApp, Run, RunContext, ScheduledWork, Schedule, Sender } from "./queue.ts";

// What the queue runs. Each run kind (a message, a schedule, a command...) has
// a handler. By default, a reply is stored in `messages` with the server's
// change notices, and `routing.route` turns it into deliveries
// (src/assistant.ts sets it up).

/** Where a reply (or a failure note) goes, as deliveries. `actions` are what the run did, for proposal buttons. */
export type Route = (tx: Tx, run: Run, text: string, actions: Action[]) => Promise<NewDelivery[]> | NewDelivery[];

export interface KindHandler {
  execute(run: Run, ctx: RunContext): Promise<Outcome>;
  /** Replaces `routing.route` for this kind. */
  route?: Route;
  /** Replaces the default finish (store the reply, route it), inside the finishing transaction. */
  complete?(tx: Tx, run: Run, outcome: Extract<Outcome, { status: "done" }>, actions: Action[]): Promise<NewDelivery[]>;
  /** Replaces the default failure (store a note, route it). */
  fail?(tx: Tx, run: Run, reason: string, actions: Action[]): Promise<NewDelivery[]>;
}

export const kinds: Record<string, KindHandler> = {};
export const senders: Record<string, Sender> = {};
export const schedulePlanners: Array<(tx: Tx, s: Schedule, now: Date) => Promise<ScheduledWork | undefined>> = [];
export const routing: { route: Route } = { route: () => [] };

export const FAILURE_TEXT = "I couldn't finish that. Could you try again?";

function handler(run: Run): KindHandler {
  const k = kinds[run.kind];
  if (!k) throw new Error(`No handler for run kind "${run.kind}"`);
  return k;
}

export const app: QueueApp = {
  execute: (run, ctx) => handler(run).execute(run, ctx),

  async completed(tx, run, outcome, actions) {
    const h = handler(run);
    if (h.complete) return h.complete(tx, run, outcome, actions);
    const text = announce(outcome.text, actions);
    await tx.execute(
      sql`insert into messages (conversation_id, run_id, role, content)
          values (${run.conversationId}, ${run.id}, 'assistant', ${text})`,
    );
    return (h.route ?? routing.route)(tx, run, text, actions);
  },

  async failed(tx, run, reason, actions) {
    const h = kinds[run.kind];
    if (h?.fail) return h.fail(tx, run, reason, actions);
    // Changes the run made before it failed are still announced.
    const text = announce(FAILURE_TEXT, actions);
    await tx.execute(
      sql`insert into messages (conversation_id, run_id, role, content, meta)
          values (${run.conversationId}, ${run.id}, 'notice', ${text}, ${JSON.stringify({ reason })}::jsonb)`,
    );
    return (h?.route ?? routing.route)(tx, run, text, actions);
  },

  async scheduled(tx, schedule, now) {
    for (const plan of schedulePlanners) {
      const work = await plan(tx, schedule, now);
      if (work) return work;
    }
    // No planner knows this schedule: retire it rather than fire it every minute.
    return { nextRunAt: null };
  },

  senders,
};

/**
 * The reply plus one line per change the run made, built by the server from
 * `actions`, never by the model. So a change is announced even when the model
 * says nothing about it, or the run fails.
 */
export function announce(text: string, actions: Action[]): string {
  const notices = actions.map((a) => a.result?.notice).filter((n): n is string => typeof n === "string");
  return [text.trim(), notices.join("\n")].filter(Boolean).join("\n\n");
}
