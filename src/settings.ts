import { sql } from "drizzle-orm";
import { type Queryable, rows } from "./db.ts";
import { personaById } from "./personas.ts";

// Owner settings, one row per key in `settings`. Defaults live here, so a
// fresh install works before anything is saved.

export const MODELS = [
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (better answers)" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (cheaper, faster)" },
] as const;

export interface TelegramOwner {
  userId: number;
  chatId: number;
  username?: string;
  firstName?: string;
}

export interface Settings {
  timezone: string;
  model: string;
  dailyCapUsd: number;
  persona: { preset: string; name: string; soul: string };
  telegram: TelegramOwner | null;
}

type Stored = Partial<{
  timezone: string;
  model: string;
  daily_cap_usd: number;
  persona: { preset?: string; name?: string; soul?: string };
  telegram: TelegramOwner;
}>;

export async function getSettings(q: Queryable): Promise<Settings> {
  const list = await rows<{ key: string; value: any }>(
    q,
    sql`select key, value from settings where key in ('timezone', 'model', 'daily_cap_usd', 'persona', 'telegram')`,
  );
  const s: Stored = Object.fromEntries(list.map((r) => [r.key, r.value]));
  const preset = personaById(s.persona?.preset);
  return {
    timezone: s.timezone ?? "UTC",
    model: MODELS.some((m) => m.id === s.model) ? s.model! : MODELS[0].id,
    dailyCapUsd: typeof s.daily_cap_usd === "number" ? s.daily_cap_usd : 2,
    persona: { preset: preset.id, name: s.persona?.name || preset.name, soul: s.persona?.soul || preset.soul },
    telegram: s.telegram ?? null,
  };
}

export async function setSetting(q: Queryable, key: string, value: unknown): Promise<void> {
  await q.execute(sql`insert into settings (key, value) values (${key}, ${JSON.stringify(value)}::jsonb)
      on conflict (key) do update set value = excluded.value, updated_at = now()`);
}

/** A setting stored as a JSON string, or null. */
export async function getText(q: Queryable, key: string): Promise<string | null> {
  const [r] = await rows<{ v: string }>(q, sql`select value #>> '{}' as v from settings where key = ${key}`);
  return r?.v ?? null;
}

export async function getSecret(q: Queryable, key: "wake_secret" | "session_secret"): Promise<string> {
  const v = await getText(q, key);
  if (!v) throw new Error(`Missing ${key}; did the migrations run?`);
  return v;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
