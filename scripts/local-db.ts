// Applies the migrations to the Postgres at DATABASE_URL, for running the
// server locally against a real Postgres instead of netlify dev's PGlite:
//
//   docker run -d --name assistant-pg -e POSTGRES_PASSWORD=dev -p <port>:5432 postgres:18
//   DATABASE_URL=postgres://postgres:dev@127.0.0.1:<port>/postgres node scripts/local-db.ts
import pg from "pg";
import { applyMigrations } from "../test/global-setup.ts";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
await client.query("create table if not exists local_migrations (name text primary key)");
const done = new Set((await client.query("select name from local_migrations")).rows.map((r) => r.name));
if (done.size === 0) {
  await applyMigrations(client);
  console.log("Applied the migrations");
} else console.log("Already migrated");
await client.query("insert into local_migrations values ('all') on conflict do nothing");
await client.end();
