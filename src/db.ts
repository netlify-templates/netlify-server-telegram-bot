import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { directUrl } from "./db-url.ts";

export { directUrl };

export type Db = NodePgDatabase & { $client: pg.Pool };
/** A transaction: Drizzle over the one connection that holds it. */
export type Tx = NodePgDatabase;
/** Anything that can run a query: the database or a transaction. */
export type Queryable = NodePgDatabase;

type Query = Parameters<Queryable["execute"]>[0];
/** The rows a query returned. */
export const rows = async <T = Record<string, any>>(q: Queryable, query: Query): Promise<T[]> =>
  ((await q.execute(query)) as unknown as { rows: T[] }).rows;
/** How many rows a statement changed. */
export const rowCount = async (q: Queryable, query: Query): Promise<number> =>
  ((await q.execute(query)) as unknown as { rowCount: number | null }).rowCount ?? 0;

export function createPool(url: string, max = 10): pg.Pool {
  const pool = new pg.Pool({
    connectionString: url,
    max,
    // The network between a server and its database cuts a connection that's
    // idle for 60 s, so let the pool close idle ones well before that.
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    query_timeout: 15_000,
    // The database gives up on its own too, before the client's deadline, so a
    // stuck statement or an abandoned transaction ends on the server. These go
    // in the connection's startup message, so they apply before any query.
    statement_timeout: 10_000,
    idle_in_transaction_session_timeout: 30_000,
    keepAlive: true,
  });
  // Without a handler, a dropped connection crashes the instance.
  pool.on("error", (err) => console.error("Database connection error", err.message));
  return pool;
}

/**
 * Runs `fn` in a transaction on one connection. Unlike Drizzle's own, it never
 * hands a connection back to the pool while a transaction may still be open on
 * it: if BEGIN, COMMIT or ROLLBACK fails or times out, the connection is
 * destroyed, so the database rolls back whatever it held, instead of the next
 * user's BEGIN running inside it and committing it.
 */
export async function transaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.$client.connect();
  let broken: Error | undefined;
  try {
    await client.query("begin");
    const result = await fn(drizzle({ client }));
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch((e: Error) => {
      broken = e;
    });
    throw err;
  } finally {
    client.release(broken);
  }
}

export function createDb(pool: pg.Pool): Db {
  return drizzle({ client: pool }) as Db;
}

let shared: { pool: pg.Pool; db: Db } | undefined;

/** The app's database, created on first use. DATABASE_URL overrides Netlify's for tests and local runs. */
export function getDb(): Db {
  if (!shared) {
    const url = process.env.DATABASE_URL ?? process.env.NETLIFY_DB_URL;
    if (!url) throw new Error("No database: NETLIFY_DB_URL isn't set. Is @netlify/database in package.json?");
    // netlify dev's local database runs every connection in one session, so use one connection there.
    const local = process.env.LOCAL_MODE === "1" && !process.env.DATABASE_URL;
    const pool = createPool(process.env.DATABASE_URL ? url : directUrl(url), local ? 1 : 10);
    shared = { pool, db: createDb(pool) };
  }
  return shared.db;
}

export async function closeDb(): Promise<void> {
  const current = shared;
  shared = undefined;
  await current?.pool.end();
}
