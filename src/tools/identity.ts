import { sql } from "drizzle-orm";
import { rows, type Tx } from "../db.ts";
import { getSettings, isValidTimezone, setSetting } from "../settings.ts";
import { nextRun, type Rule } from "../time.ts";
import type { ChangeTool } from "./types.ts";

/** Sets the owner's time zone. Daily schedules follow the owner's clock, so their next times move too. */
export async function changeTimezone(tx: Tx, timezone: string): Promise<void> {
  await setSetting(tx, "timezone", timezone);
  const daily = await rows<{ id: number; rule: Rule }>(tx, sql`select id, rule from schedules where rule->>'kind' = 'daily' and not paused`);
  for (const s of daily) await tx.execute(sql`update schedules set next_run_at = ${nextRun(s.rule, new Date(), timezone)} where id = ${s.id}`);
}

export const setTimezone: ChangeTool = {
  kind: "change",
  label: "Setting the time zone",
  definition: {
    name: "set_timezone",
    description: "Set the owner's IANA time zone, like Europe/Lisbon or America/New_York. Call it as soon as you learn where they are.",
    input_schema: { type: "object", properties: { timezone: { type: "string" } }, required: ["timezone"], additionalProperties: false },
    strict: true,
  },
  check: async ({ timezone }) => (isValidTimezone(String(timezone)) ? null : `"${timezone}" isn't a time zone I know.`),
  describe: ({ timezone }) => `Set the time zone to ${timezone}`,
  async apply(tx, { timezone }) {
    await changeTimezone(tx, timezone);
    return { text: `Time zone set to ${timezone}.`, notice: `🌍 Time zone set to ${timezone}` };
  },
};

export const updateIdentity: ChangeTool = {
  kind: "change",
  label: "Updating the persona",
  definition: {
    name: "update_identity",
    description:
      "Change your own name, your soul (the persona text that shapes how you behave), or both, when the owner asks. Pass only what changes; `soul` replaces the whole text.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" }, soul: { type: "string" } },
      additionalProperties: false,
    },
  },
  async check({ name, soul }) {
    if (!name && !soul) return "Give a name, a soul, or both.";
    if (name && String(name).length > 40) return "A name can be 40 characters at most.";
    if (soul && String(soul).length > 2_000) return "A soul can be 2,000 characters at most.";
    return null;
  },
  // The whole new soul, so the owner confirms exactly what will apply.
  describe: ({ name, soul }) => [name && `Rename yourself to ${name}`, soul && `Replace your soul with:\n${String(soul)}`].filter(Boolean).join("\n"),
  async apply(tx, { name, soul }) {
    const current = (await getSettings(tx)).persona;
    const persona = { ...current, ...(name ? { name: String(name) } : {}), ...(soul ? { soul: String(soul) } : {}) };
    await setSetting(tx, "persona", persona);
    const what = [name && `name ${name}`, soul && "a new soul"].filter(Boolean).join(" and ");
    return { text: "Persona updated; it takes effect from the next message.", notice: `🎭 Persona updated: ${what}` };
  },
};
