import type { Config } from "@netlify/functions";
import pg from "pg";
import { withVerifyFull } from "../../src/db-url.ts";
import { WAKE_PATH, WORK_DUE_SQL, signWake } from "../../src/wake.ts";

// Every minute: one query. Only when something is due (a schedule, a run whose
// holder is gone, a delivery) does it call the server, which starts it if it's
// stopped. Scheduled functions only run on the published production deploy.
export default async () => {
  const url = process.env.NETLIFY_DB_URL;
  if (!url) return console.log("wake: no database yet");

  const started = performance.now();
  const client = new pg.Client({ connectionString: withVerifyFull(url), connectionTimeoutMillis: 15_000, query_timeout: 15_000 });
  let row: { due: boolean; secret: string | null } | undefined;
  try {
    await client.connect();
    row = (await client.query(WORK_DUE_SQL)).rows[0];
  } finally {
    await client.end().catch(() => {});
  }
  const queryMs = Math.round(performance.now() - started);
  if (!row?.due) return console.log(`wake: nothing due (query ${queryMs} ms)`);
  if (!row.secret) return console.error("wake: work is due but there's no wake key; did the migrations run?");

  const siteUrl = Netlify.context?.site?.url ?? process.env.URL;
  if (!siteUrl) return console.error("wake: no site URL");
  const ts = Math.floor(Date.now() / 1000);
  const res = await fetch(new URL(WAKE_PATH, siteUrl), {
    method: "POST",
    headers: { "x-wake-ts": String(ts), "x-wake-sig": signWake(row.secret, ts) },
  });
  console.log(`wake: work due (query ${queryMs} ms); server answered ${res.status} in ${Math.round(performance.now() - started - queryMs)} ms`);
};

export const config: Config = { schedule: "* * * * *" };
