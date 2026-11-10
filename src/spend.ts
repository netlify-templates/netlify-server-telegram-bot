import { sql } from "drizzle-orm";
import { type Queryable, rowCount, rows } from "./db.ts";

// The spend guard. Before each model call, the run
// reserves that call's worst case against today's cap, in one statement. If
// the reservation would pass the cap, the call isn't made. After the call, the
// reservation is replaced by what it actually cost. A call interrupted before
// its usage came back keeps its reservation, so an unknown cost counts as the
// worst case. The cap can only be passed by usage the API doesn't report.

/** Dollars per million tokens. Cache writes are the 5-minute kind (1.25x input). */
export const PRICES: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  // Prompts over 100K tokens cost twice as much on Haiku 5.5; the starter's stay far below that.
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  // A refusal fallback can be served by a stronger model; Opus is the priciest it routes to.
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
};
export const WEB_SEARCH_USD = 0.01; // $10 per 1,000 searches

const priceOf = (model: string) => PRICES[model] ?? PRICES["claude-opus-5-5"];

/** A deliberately high estimate of a request's input tokens: about 3 bytes of JSON per token, plus images. */
export function estimateInputTokens(request: unknown, images = 0): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(request)) / 3) + images * 1_600;
}

/**
 * The most a call can cost. Every input token is priced as a cache write, and
 * with hosted web tools the call can add up to `hostedTokens` of results to
 * its input and re-read the whole input once per tool use (`rereads`).
 */
export function worstCaseUsd(
  models: string[],
  c: { inputTokens: number; outputTokens: number; searches: number; hostedTokens?: number; rereads?: number },
): number {
  const input = c.inputTokens + (c.hostedTokens ?? 0);
  return (
    Math.max(
      ...models.map((m) => {
        const p = priceOf(m);
        return (input * Math.max(p.input, p.cacheWrite) + (c.rereads ?? 0) * input * p.input + c.outputTokens * p.output) / 1e6;
      }),
    ) + c.searches * WEB_SEARCH_USD
  );
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
}

/** What a call cost, priced at the most expensive of the models that may have served it. */
export function actualUsd(models: string[], usage: Usage): number {
  return Math.max(
    ...models.map((m) => {
      const p = priceOf(m);
      return (
        (usage.input_tokens * p.input +
          (usage.cache_creation_input_tokens ?? 0) * p.cacheWrite +
          (usage.cache_read_input_tokens ?? 0) * p.cacheRead +
          usage.output_tokens * p.output) /
        1e6
      );
    }),
  ) + (usage.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_USD;
}

/** Reserves `amount` for `day` if it fits under `cap`. False means the cap would be passed. */
export async function reserve(q: Queryable, day: string, cap: number, amount: number): Promise<boolean> {
  await q.execute(sql`insert into spend_days (day) values (${day}) on conflict do nothing`);
  const changed = await rowCount(
    q,
    sql`update spend_days set reserved = reserved + ${amount}, updated_at = now()
        where day = ${day} and spent + reserved + ${amount} <= ${cap}`,
  );
  return changed === 1;
}

/** Replaces a reservation with what the call actually cost. */
export async function settle(q: Queryable, day: string, reserved: number, actual: number): Promise<void> {
  await q.execute(
    sql`update spend_days set reserved = greatest(0, reserved - ${reserved}), spent = spent + ${actual}, updated_at = now()
        where day = ${day}`,
  );
}

export async function spendSummary(q: Queryable, today: string) {
  const days = await rows<{ day: string; spent: number; reserved: number }>(
    q,
    sql`select day::text, spent::float8 as spent, reserved::float8 as reserved from spend_days order by day desc limit 14`,
  );
  const t = days.find((r) => r.day === today);
  return { today: t?.spent ?? 0, reserved: t?.reserved ?? 0, days: days.map(({ day, spent }) => ({ day, spent })) };
}
