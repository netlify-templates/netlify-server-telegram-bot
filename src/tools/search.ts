import { reserve, settle } from "../spend.ts";
import { localDay } from "../time.ts";
import type { ReadTool } from "./types.ts";

// Web search through OpenRouter's web plugin (Exa), reached through the AI
// Gateway, which sets OPENROUTER_BASE_URL and OPENROUTER_API_KEY. Anthropic's
// hosted search ranks a site's own pages poorly: "Hacker News" didn't return
// news.ycombinator.com (docs/checks.md, check 6). The URLs in this tool's
// results count for Anthropic's hosted fetch, which only opens URLs already in
// the conversation. Without the gateway's OpenRouter variables, the agent uses
// the hosted search instead.

export const SEARCHES_PER_RUN = 4;
const RESULTS = 5;
const SNIPPET_CHARS = 1_200;
/** Reserved per search. A search costs about $0.007, reported back, which is what gets charged. */
export const SEARCH_RESERVE_USD = 0.02;
// The plugin needs a model to run on. Its output is cut at 16 tokens and thrown away.
const MODEL = "openai/gpt-oss-20b";

export const searchAvailable = () => Boolean(process.env.OPENROUTER_BASE_URL && process.env.OPENROUTER_API_KEY);

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
}

/** OpenRouter answered with an error, so the search wasn't charged. */
class SearchRefused extends Error {}

export async function openrouterSearch(query: string, signal?: AbortSignal): Promise<{ results: SearchResult[]; costUsd: number | null }> {
  const timeout = AbortSignal.timeout(20_000);
  const res = await fetch(`${process.env.OPENROUTER_BASE_URL!.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16,
      plugins: [{ id: "web", engine: "exa", max_results: RESULTS }],
      messages: [{ role: "user", content: query }],
    }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const body = (await res.json().catch(() => null)) as any;
  if (!res.ok || !body) throw new SearchRefused(`The search failed (${res.status}). Try again, or answer without it.`);
  const results: SearchResult[] = (body.choices?.[0]?.message?.annotations ?? [])
    .filter((a: any) => a?.type === "url_citation" && typeof a.url_citation?.url === "string")
    .map((a: any) => ({
      url: a.url_citation.url,
      title: String(a.url_citation.title ?? "").trim(),
      snippet: String(a.url_citation.content ?? "").replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS),
    }));
  return { results, costUsd: typeof body.usage?.cost === "number" ? body.usage.cost : null };
}

export const webSearch: ReadTool = {
  kind: "read",
  label: "Searching the web",
  definition: {
    name: "web_search",
    description:
      "Search the web. Returns the top 5 results, each with its URL, title and a snippet of the page's text. Use it for anything current or that you're unsure of, and to find a site's address before fetching it. Search in a few words, the way you'd type into a search engine.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "What to search for." } },
      required: ["query"],
    },
  },
  async run(input, tc) {
    const query = String(input?.query ?? "").trim().slice(0, 300);
    if (!query) return "Give a query to search for.";
    if (tc.searchesLeft !== undefined) {
      if (tc.searchesLeft <= 0) return `That's ${SEARCHES_PER_RUN} searches for this message, the most I do. Answer with what you have.`;
      tc.searchesLeft--;
    }
    const day = localDay(new Date(), tc.settings.timezone);
    if (!(await reserve(tc.db, day, tc.settings.dailyCapUsd, SEARCH_RESERVE_USD))) return "Today's spending limit is reached, so searching is off for now.";
    let cost = SEARCH_RESERVE_USD; // what an unknown outcome counts as
    try {
      const { results, costUsd } = await openrouterSearch(query, tc.signal);
      cost = costUsd ?? SEARCH_RESERVE_USD;
      console.log(`run ${tc.runId}: web_search ${JSON.stringify(query)} → ${results.map((r) => r.url).join(" ") || "(none)"}`);
      if (results.length === 0) return "No results.";
      return { text: results.map((r, i) => `${i + 1}. ${r.title || r.url}\n${r.url}\n${r.snippet}`).join("\n\n"), outside: true };
    } catch (err) {
      if (err instanceof SearchRefused) cost = 0;
      throw err;
    } finally {
      await settle(tc.db, day, SEARCH_RESERVE_USD, cost);
    }
  },
};
