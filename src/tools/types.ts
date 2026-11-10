import type Anthropic from "@anthropic-ai/sdk";
import type { Db, Tx } from "../db.ts";
import type { Settings } from "../settings.ts";

// A tool is one file's worth of { definition, run }.
// Register it in src/tools/index.ts.

export interface ToolContext {
  db: Db;
  settings: Settings;
  conversationId: string;
  runId: number;
  /** The run's abort signal, for tools that call out. */
  signal?: AbortSignal;
  /** Web searches this run may still make. */
  searchesLeft?: number;
}

/** A tool that only reads. Offered in every run. */
export interface ReadTool {
  kind: "read";
  definition: Anthropic.Beta.BetaTool;
  /** A one-line note for the console while it runs, like "Searching history". */
  label: string;
  /** Text for the model. `outside: true` means it carries outside text (a forwarded message, say). */
  run(input: any, tc: ToolContext): Promise<string | { text: string; outside: boolean }>;
}

/**
 * A tool that changes something. The agent runs it through the queue's
 * `act()`: the change and its `actions` record commit together, fenced by the
 * run's claim, and a retried run replays it instead of acting again. It's not
 * offered in scheduled runs, and after the run read outside text it only
 * proposes.
 */
export interface ChangeTool {
  kind: "change";
  definition: Anthropic.Beta.BetaTool;
  label: string;
  /** An error message for an input it won't accept, checked before acting. */
  check(input: any, tc: ToolContext): Promise<string | null>;
  /** One line describing the change, for a proposal. */
  describe(input: any, tc: ToolContext): string;
  apply(tx: Tx, input: any, tc: ToolContext): Promise<Change>;
}

export interface Change {
  /** What the model gets back. */
  text: string;
  /** The line the server announces after the run, with its undo. */
  notice: string;
}

export type Tool = ReadTool | ChangeTool;


