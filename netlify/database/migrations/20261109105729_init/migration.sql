CREATE TABLE "actions" (
	"run_id" integer,
	"seq" integer,
	"attempt" integer NOT NULL,
	"kind" text NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "actions_pkey" PRIMARY KEY("run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY,
	"holder_token" uuid,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "deliveries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"run_id" integer,
	"channel" text NOT NULL,
	"destination" text NOT NULL,
	"text" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"claim_token" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"give_up_at" timestamp with time zone DEFAULT now() + interval '24 hours' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "deliveries_state_check" CHECK ("state" in ('pending', 'sending', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "inbound" (
	"channel" text,
	"key" text,
	"run_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_pkey" PRIMARY KEY("channel","key")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"conversation_id" text NOT NULL,
	"run_id" integer,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple', "messages"."content")) STORED
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"conversation_id" text NOT NULL,
	"kind" text NOT NULL,
	"origin" text NOT NULL,
	"input" jsonb NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"claim_token" uuid,
	"not_before" timestamp with time zone DEFAULT now() NOT NULL,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "runs_state_check" CHECK ("state" in ('queued', 'running', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "schedules_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"conversation_id" text NOT NULL,
	"instruction" text NOT NULL,
	"mode" text DEFAULT 'notify' NOT NULL,
	"rule" jsonb NOT NULL,
	"next_run_at" timestamp with time zone,
	"paused" boolean DEFAULT false NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_report" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedules_mode_check" CHECK ("mode" in ('notify', 'watch'))
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "deliveries_pending_idx" ON "deliveries" ("next_attempt_at") WHERE "state" = 'pending';--> statement-breakpoint
CREATE INDEX "deliveries_sending_idx" ON "deliveries" ("lease_until") WHERE "state" = 'sending';--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" ("conversation_id","id");--> statement-breakpoint
CREATE INDEX "messages_tsv_idx" ON "messages" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "runs_open_idx" ON "runs" ("conversation_id","created_at") WHERE "state" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "schedules_due_idx" ON "schedules" ("next_run_at") WHERE not "paused" and "next_run_at" is not null;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id");--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id");--> statement-breakpoint
ALTER TABLE "inbound" ADD CONSTRAINT "inbound_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id");--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id");--> statement-breakpoint
-- The key the wake function signs its calls with. gen_random_uuid() is cryptographically random: 244 bits here.
INSERT INTO "settings" ("key", "value") VALUES ('wake_secret', to_jsonb(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))) ON CONFLICT DO NOTHING;
