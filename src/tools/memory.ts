import { sql } from "drizzle-orm";
import { type Queryable, rows } from "../db.ts";
import type { ChangeTool } from "./types.ts";

// Memory notes: up to 400 characters each and 6,000 in total, all in the
// prompt. When it's full, the model has to merge or forget notes first.

export const NOTE_MAX = 400;
export const NOTES_TOTAL = 6_000;

/** Why `content` can't be saved as a note (or replace note `except`), or null. The tools and the console both check this. */
export async function noteProblem(q: Queryable, content: string, except?: number): Promise<string | null> {
  if (!content) return "A note can't be empty.";
  if (content.length > NOTE_MAX) return `A note can be ${NOTE_MAX} characters at most; this one is ${content.length}.`;
  const [{ n }] = await rows<{ n: number }>(q, sql`select coalesce(sum(length(content)), 0)::int as n from notes where id <> ${except ?? -1}`);
  return n + content.length > NOTES_TOTAL ? `Memory is full (${n} of ${NOTES_TOTAL} characters). Merge or delete notes first.` : null;
}

export const remember: ChangeTool = {
  kind: "change",
  label: "Saving a note",
  definition: {
    name: "remember",
    description:
      "Save a durable fact about the owner to memory: preferences, people, places, ongoing projects, important dates. Use it when you learn something you'd want to know next week. One self-contained fact per note, about the owner by name ('Sam takes coffee black'), with no pronouns for them unless they've told you theirs. Don't save trivia or what's already in memory; update a note instead.",
    input_schema: {
      type: "object",
      properties: { content: { type: "string", description: `The fact, at most ${NOTE_MAX} characters.` } },
      required: ["content"],
      additionalProperties: false,
    },
    strict: true,
  },
  check: ({ content }, { db }) => noteProblem(db, String(content ?? "").trim()),
  describe: ({ content }) => `Remember: ${String(content).trim()}`,
  async apply(tx, { content }) {
    const text = String(content).trim();
    const [note] = await rows<{ id: number }>(tx, sql`insert into notes (content) values (${text}) returning id`);
    return { text: `Saved as note ${note.id}.`, notice: `📝 Noted: ${text} (/forget ${note.id})` };
  },
};

export const updateNote: ChangeTool = {
  kind: "change",
  label: "Updating a note",
  definition: {
    name: "update_note",
    description: "Replace a memory note's text, to correct it or to merge two notes into one (then forget the other).",
    input_schema: {
      type: "object",
      properties: { id: { type: "integer" }, content: { type: "string", description: `At most ${NOTE_MAX} characters.` } },
      required: ["id", "content"],
      additionalProperties: false,
    },
    strict: true,
  },
  async check({ id, content }, { db }) {
    const [note] = await rows(db, sql`select id from notes where id = ${Number(id)}`);
    if (!note) return `There's no note ${id}.`;
    return noteProblem(db, String(content ?? "").trim(), Number(id));
  },
  describe: ({ id, content }) => `Change note ${id} to: ${String(content).trim()}`,
  async apply(tx, { id, content }) {
    const text = String(content).trim();
    const updated = await rows(tx, sql`update notes set content = ${text}, updated_at = now() where id = ${Number(id)} returning id`);
    if (updated.length === 0) throw new Error(`There's no note ${id}.`);
    return { text: `Note ${id} updated.`, notice: `📝 Updated note ${id}: ${text}` };
  },
};

export const forget: ChangeTool = {
  kind: "change",
  label: "Forgetting a note",
  definition: {
    name: "forget",
    description: "Delete a memory note by id, when it's wrong or outdated or the owner asks you to forget it.",
    input_schema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"], additionalProperties: false },
    strict: true,
  },
  async check({ id }, { db }) {
    const [note] = await rows(db, sql`select id from notes where id = ${Number(id)}`);
    return note ? null : `There's no note ${id}.`;
  },
  describe: ({ id }) => `Forget note ${id}`,
  async apply(tx, { id }) {
    const [note] = await rows<{ content: string }>(tx, sql`delete from notes where id = ${Number(id)} returning content`);
    if (!note) throw new Error(`There's no note ${id}.`);
    return { text: `Note ${id} deleted.`, notice: `🗑️ Forgot note ${id}: ${note.content}` };
  },
};

export async function listNotes(q: Queryable) {
  return rows<{ id: number; content: string; updated_at: string }>(q, sql`select id, content, updated_at from notes order by id`);
}

export const memoryTools = [remember, updateNote, forget];
