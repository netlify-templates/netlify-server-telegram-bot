import { type SQL, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const tz = { withTimezone: true } as const;
const createdAt = () => timestamp("created_at", tz).defaultNow().notNull();
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

// ---------------------------------------------------------------------------
// The run queue. The rules that use these tables are
// in src/queue.ts.
// ---------------------------------------------------------------------------

/** One chat. Its lease is the lock that lets one run at a time work in it, across instances. */
export const conversations = pgTable("conversations", {
  id: text().primaryKey(),
  holderToken: uuid("holder_token"),
  leaseUntil: timestamp("lease_until", tz),
  createdAt: createdAt(),
});

/** Work for the assistant: a message to answer, a schedule that came due. */
export const runs = pgTable(
  "runs",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    kind: text().notNull(),
    /** Where the run came from: "telegram", "console", "schedule". Decides where the reply goes. */
    origin: text().notNull(),
    input: jsonb().notNull(),
    state: text().notNull().default("queued"),
    attempt: integer().notNull().default(0),
    claimToken: uuid("claim_token"),
    /** Not eligible before this time. The spend cap defers work by moving it. */
    notBefore: timestamp("not_before", tz).defaultNow().notNull(),
    result: jsonb(),
    error: text(),
    createdAt: createdAt(),
    startedAt: timestamp("started_at", tz),
    finishedAt: timestamp("finished_at", tz),
  },
  (t) => [
    check("runs_state_check", sql`${t.state} in ('queued', 'running', 'done', 'failed')`),
    index("runs_open_idx")
      .on(t.conversationId, t.createdAt)
      .where(sql`${t.state} in ('queued', 'running')`),
  ],
);

/** The outbox: replies waiting to be sent to a channel. */
export const deliveries = pgTable(
  "deliveries",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    runId: integer("run_id").references(() => runs.id),
    channel: text().notNull(),
    destination: text().notNull(),
    text: text().notNull(),
    state: text().notNull().default("pending"),
    attempt: integer().notNull().default(0),
    /** Parts of a long message already sent, so a retry resumes after them. */
    progress: integer().notNull().default(0),
    claimToken: uuid("claim_token"),
    leaseUntil: timestamp("lease_until", tz),
    nextAttemptAt: timestamp("next_attempt_at", tz).defaultNow().notNull(),
    giveUpAt: timestamp("give_up_at", tz)
      .default(sql`now() + interval '24 hours'`)
      .notNull(),
    lastError: text("last_error"),
    /** Channel extras, such as Confirm and Discard buttons for a proposal. */
    meta: jsonb(),
    createdAt: createdAt(),
    sentAt: timestamp("sent_at", tz),
  },
  (t) => [
    check("deliveries_state_check", sql`${t.state} in ('pending', 'sending', 'sent', 'failed')`),
    index("deliveries_pending_idx").on(t.nextAttemptAt).where(sql`${t.state} = 'pending'`),
    index("deliveries_sending_idx").on(t.leaseUntil).where(sql`${t.state} = 'sending'`),
  ],
);

/** What mutating tools did in a run, so a retry of the run doesn't do it again. */
export const actions = pgTable(
  "actions",
  {
    runId: integer("run_id")
      .notNull()
      .references(() => runs.id),
    seq: integer().notNull(),
    attempt: integer().notNull(),
    kind: text().notNull(),
    result: jsonb(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.seq] })],
);

/** Ingress dedupe: one row per channel event (Telegram's update_id, say). */
export const inbound = pgTable(
  "inbound",
  {
    channel: text().notNull(),
    key: text().notNull(),
    runId: integer("run_id").references(() => runs.id),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.channel, t.key] })],
);

// ---------------------------------------------------------------------------
// The conversation and its schedules
// ---------------------------------------------------------------------------

/** Everything said in a conversation, searchable with Postgres full-text search. */
export const messages = pgTable(
  "messages",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    runId: integer("run_id").references(() => runs.id),
    /** "user", "assistant", or "notice" for lines the server adds (failures, change notices). */
    role: text().notNull(),
    content: text().notNull(),
    meta: jsonb(),
    createdAt: createdAt(),
    // The "simple" configuration doesn't stem, so it works for any language, Hebrew included.
    tsv: tsvector().generatedAlwaysAs((): SQL => sql`to_tsvector('simple', ${messages.content})`),
  },
  (t) => [
    index("messages_conversation_idx").on(t.conversationId, t.id),
    index("messages_tsv_idx").using("gin", t.tsv),
  ],
);

/** Reminders and recurring jobs. Claiming a due one computes its next time in the same transaction. */
export const schedules = pgTable(
  "schedules",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    instruction: text().notNull(),
    /** "notify", or "watch" to speak only when something changed. */
    mode: text().notNull().default("notify"),
    /** { at } once, { daily, weekdays } at a local time, or { everyHours }. */
    rule: jsonb().notNull(),
    nextRunAt: timestamp("next_run_at", tz),
    paused: boolean().notNull().default(false),
    failures: integer().notNull().default(0),
    lastReport: text("last_report"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", tz).defaultNow().notNull(),
  },
  (t) => [
    check("schedules_mode_check", sql`${t.mode} in ('notify', 'watch')`),
    index("schedules_due_idx")
      .on(t.nextRunAt)
      .where(sql`not ${t.paused} and ${t.nextRunAt} is not null`),
  ],
);

/** Owner, time zone, model, persona, caps, and server secrets such as the wake key. */
export const settings = pgTable("settings", {
  key: text().primaryKey(),
  value: jsonb().notNull(),
  updatedAt: timestamp("updated_at", tz).defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Memory, proposals, spend and sign-in
// ---------------------------------------------------------------------------

/** Memory notes, in the prompt with their ids. Up to 400 characters each, 6,000 in total. */
export const notes = pgTable("notes", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  content: text().notNull(),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", tz).defaultNow().notNull(),
});

/** Changes suggested by a run that had read outside text, waiting for the owner's tap. */
export const proposals = pgTable(
  "proposals",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    runId: integer("run_id").references(() => runs.id),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    /** The tool that would make the change, and its input. */
    tool: text().notNull(),
    input: jsonb().notNull(),
    summary: text().notNull(),
    state: text().notNull().default("pending"),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", tz)
      .default(sql`now() + interval '24 hours'`)
      .notNull(),
    decidedAt: timestamp("decided_at", tz),
  },
  (t) => [check("proposals_state_check", sql`${t.state} in ('pending', 'confirmed', 'discarded', 'expired')`)],
);

/** Model spend per local day: what calls cost, and what calls in flight have reserved. */
export const spendDays = pgTable("spend_days", {
  day: date().primaryKey(),
  spent: numeric({ precision: 12, scale: 6 }).notNull().default("0"),
  reserved: numeric({ precision: 12, scale: 6 }).notNull().default("0"),
  updatedAt: timestamp("updated_at", tz).defaultNow().notNull(),
});

/** Console sign-in attempts, so throttling survives instance replacement. */
export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    ok: boolean().notNull(),
    at: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("login_attempts_at_idx").on(t.at)],
);

/** One-time Telegram pairing links: the token's hash and its expiry. */
export const pairingTokens = pgTable("pairing_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  expiresAt: timestamp("expires_at", tz).notNull(),
  usedAt: timestamp("used_at", tz),
});

/** Telegram users who aren't the owner and already got their one refusal. */
export const telegramStrangers = pgTable("telegram_strangers", {
  userId: bigint("user_id", { mode: "number" }).primaryKey(),
  refusedAt: timestamp("refused_at", tz).defaultNow().notNull(),
});
