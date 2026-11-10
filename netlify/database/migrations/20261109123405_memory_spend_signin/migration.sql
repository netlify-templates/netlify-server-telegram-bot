CREATE TABLE "login_attempts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "login_attempts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"ok" boolean NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pairing_tokens" (
	"token_hash" text PRIMARY KEY,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "proposals_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"run_id" integer,
	"conversation_id" text NOT NULL,
	"tool" text NOT NULL,
	"input" jsonb NOT NULL,
	"summary" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '24 hours' NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "proposals_state_check" CHECK ("state" in ('pending', 'confirmed', 'discarded', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "spend_days" (
	"day" date PRIMARY KEY,
	"spent" numeric(12,6) DEFAULT '0' NOT NULL,
	"reserved" numeric(12,6) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_strangers" (
	"user_id" bigint PRIMARY KEY,
	"refused_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "meta" jsonb;--> statement-breakpoint
CREATE INDEX "login_attempts_at_idx" ON "login_attempts" ("at");--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id");--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id");--> statement-breakpoint
-- The key that signs console session cookies.
INSERT INTO "settings" ("key", "value") VALUES ('session_secret', to_jsonb(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))) ON CONFLICT DO NOTHING;
