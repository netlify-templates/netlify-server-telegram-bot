import { sql } from "drizzle-orm";
import { formatLocal } from "../time.ts";
import type { ReadTool } from "./types.ts";
import { rows } from "../db.ts";

// Search over past conversations with Postgres full-text search. The `simple`
// configuration doesn't stem, so it works for any language, Hebrew included.

/** An OR query over the words, each also matching as a prefix. Only letters and digits get through. */
export function toTsquery(query: string): string | null {
  const words = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 12);
  return words.length ? words.map((w) => `${w}:*`).join(" | ") : null;
}

export const searchHistory: ReadTool = {
  kind: "read",
  label: "Searching past conversations",
  definition: {
    name: "search_history",
    description:
      "Search everything said in past conversations, beyond the recent messages you can see. Returns up to 8 snippets with dates and message ids; use read_history to see one in context.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    strict: true,
  },
  async run({ query }, { db, settings }) {
    const q = toTsquery(String(query));
    if (!q) return "Give some words to search for.";
    const hits = await rows<{ id: number; role: string; created_at: string; snippet: string; forwarded: boolean }>(
      db,
      sql`select id, role, created_at, coalesce((meta->>'forwarded')::boolean, false) as forwarded,
                 ts_headline('simple', content, to_tsquery('simple', ${q}), 'MaxWords=30, MinWords=10, MaxFragments=1') as snippet
          from messages
          where tsv @@ to_tsquery('simple', ${q}) and role in ('user', 'assistant') and conversation_id <> 'probe'
          order by ts_rank_cd(tsv, to_tsquery('simple', ${q})) / (1 + extract(epoch from now() - created_at) / 86400 / 30) desc
          limit 8`,
    );
    if (hits.length === 0) return "Nothing found.";
    const text = hits
      .map((h) => `[${h.id}] ${formatLocal(new Date(h.created_at), settings.timezone)}, ${h.role === "user" ? (h.forwarded ? "forwarded" : "owner") : "you"}: ${h.snippet}`)
      .join("\n");
    return { text, outside: hits.some((h) => h.forwarded) };
  },
};

export const readHistory: ReadTool = {
  kind: "read",
  label: "Reading past messages",
  definition: {
    name: "read_history",
    description: "Show the messages around one message id from search_history.",
    input_schema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"], additionalProperties: false },
    strict: true,
  },
  async run({ id }, { db, settings }) {
    const list = await rows<{ id: number; role: string; created_at: string; content: string; forwarded: boolean }>(
      db,
      sql`select id, role, created_at, content, coalesce((meta->>'forwarded')::boolean, false) as forwarded from (
            (select * from messages where id <= ${Number(id)} and role in ('user', 'assistant') order by id desc limit 5)
            union all
            (select * from messages where id > ${Number(id)} and role in ('user', 'assistant') order by id limit 4)) m
          order by id`,
    );
    if (list.length === 0) return `There's no message ${id}.`;
    const text = list
      .map((m) => `[${m.id}] ${formatLocal(new Date(m.created_at), settings.timezone)}, ${m.role === "user" ? (m.forwarded ? "forwarded" : "owner") : "you"}: ${m.content.slice(0, 1_500)}`)
      .join("\n\n");
    return { text, outside: list.some((m) => m.forwarded) };
  },
};
