import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { inject } from "vitest";
import { createDb, createPool, type Db, rows } from "../src/db.ts";
import { createQueue, type QueueApp, type QueueOptions } from "../src/queue.ts";
import { WORK_DUE_SQL } from "../src/wake.ts";

/** A fresh database per test, copied from the migrated template. */
export async function freshDatabase() {
  const adminUrl = inject("pgAdminUrl");
  const name = `t_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${name} template assistant_template`);
  await admin.end();
  const url = adminUrl.replace(/\/[^/]*$/, `/${name}`);
  const pools: pg.Pool[] = [];

  return {
    url,
    /** A separate pool, like another instance's. */
    connect(max = 5): Db {
      const pool = createPool(url, max);
      pools.push(pool);
      return createDb(pool);
    },
    async close() {
      await Promise.all(pools.map((p) => p.end()));
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      await a.query(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}

export type TestDatabase = Awaited<ReturnType<typeof freshDatabase>>;

export const query = <T = any>(db: Db, q: ReturnType<typeof sql>): Promise<T[]> => rows<T>(db, q);

/** The wake function's own query: is anything due? */
export async function workDue(db: Db): Promise<boolean> {
  const [row] = await rows<{ due: boolean }>(db, sql.raw(WORK_DUE_SQL));
  return row.due;
}

/** An app whose runs answer right away, and whose "test" channel records what it sends. */
export function testApp(overrides: Partial<QueueApp> = {}) {
  const sent: { destination: string; text: string; resend: boolean; progress: number }[] = [];
  const app: QueueApp = {
    execute: async (run) => ({ status: "done", text: `answer ${run.id}` }),
    async completed(tx, run, outcome) {
      await tx.execute(
        sql`insert into messages (conversation_id, run_id, role, content) values (${run.conversationId}, ${run.id}, 'assistant', ${outcome.text})`,
      );
      return [{ channel: "test", destination: run.conversationId, text: outcome.text }];
    },
    async failed(tx, run, reason) {
      await tx.execute(
        sql`insert into messages (conversation_id, run_id, role, content) values (${run.conversationId}, ${run.id}, 'notice', ${"failed: " + reason})`,
      );
      return [{ channel: "test", destination: run.conversationId, text: `failed ${run.id}` }];
    },
    senders: {
      test: async (d) => {
        sent.push({ destination: d.destination, text: d.text, resend: d.resend, progress: d.progress });
      },
    },
    ...overrides,
  };
  return { app, sent };
}

export function queueOn(db: Db, app: QueueApp, extra: Partial<QueueOptions> = {}) {
  return createQueue({ db, app, log: () => {}, ...extra });
}

export async function enqueue(db: Db, conversationId: string, input: unknown = {}, kind = "test") {
  const { insertRun } = await import("../src/queue.ts");
  return insertRun(db, { conversationId, kind, origin: "test", input });
}

export const expireLease = (db: Db, conversationId: string) =>
  db.execute(sql`update conversations set lease_until = now() - interval '1 second' where id = ${conversationId}`);
