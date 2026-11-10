import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { actualUsd, reserve, settle, worstCaseUsd } from "../src/spend.ts";
import { freshDatabase, query, type TestDatabase } from "./helpers.ts";

let t: TestDatabase;
beforeEach(async () => {
  t = await freshDatabase();
});
afterEach(async () => {
  await t.close();
});

describe("spend guard", () => {
  it("prices the worst case and the actual cost", () => {
    // 10,000 input tokens written to the cache at $2.50/M plus 4,000 output at $10/M, plus 3 searches.
    expect(worstCaseUsd(["claude-sonnet-5-5"], { inputTokens: 10_000, outputTokens: 4_000, searches: 3 })).toBeCloseTo(0.025 + 0.04 + 0.03, 6);
    // With hosted web tools: 20,000 tokens of results, re-read twice at $2/M.
    expect(
      worstCaseUsd(["claude-sonnet-5-5"], { inputTokens: 10_000, outputTokens: 4_000, searches: 2, hostedTokens: 20_000, rereads: 2 }),
    ).toBeCloseTo(0.075 + 0.12 + 0.04 + 0.02, 6);
    expect(
      actualUsd(["claude-sonnet-5-5"], {
        input_tokens: 1_000,
        output_tokens: 500,
        cache_read_input_tokens: 9_000,
        cache_creation_input_tokens: 0,
        server_tool_use: { web_search_requests: 1 },
      }),
    ).toBeCloseTo(0.002 + 0.005 + 0.0018 + 0.01, 6);
  });

  it("refuses a reservation that would pass the cap, also when instances race", async () => {
    const dbs = Array.from({ length: 6 }, () => t.connect(2));
    // Six calls at $0.40 each against a $2 cap: exactly five fit.
    const results = await Promise.all(dbs.map((db) => reserve(db, "2026-11-09", 2, 0.4)));
    expect(results.filter(Boolean)).toHaveLength(5);

    // Settling replaces the reservation with the real cost and frees room.
    await settle(dbs[0], "2026-11-09", 0.4, 0.05);
    expect(await reserve(dbs[0], "2026-11-09", 2, 0.3)).toBe(true);
    const [row] = await query(dbs[0], sql`select spent::float8 as spent, reserved::float8 as reserved from spend_days`);
    expect(row.spent).toBeCloseTo(0.05, 6);
    expect(row.reserved).toBeCloseTo(1.9, 6);
  });
});
