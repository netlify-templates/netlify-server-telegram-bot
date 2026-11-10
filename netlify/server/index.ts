import { type Config, getContext, onShutdown } from "@netlify/server";
import { Hono } from "hono";
import { registerAssistant } from "../../src/assistant.ts";
import { WEBHOOK_PATH } from "../../src/channels/telegram.ts";
import { telegramWebhook } from "../../src/channels/telegram-webhook.ts";
import api, { closeStreams } from "../../src/console.ts";
import { closeDb, getDb } from "../../src/db.ts";
import { BUILD_ID, INSTANCE_ID, STARTED_AT } from "../../src/instance.ts";
import { isLiveDeploy } from "../../src/live.ts";
import { registerProbe } from "../../src/probe.ts";
import { deployHash, getQueue, hasQueue, startDrain } from "../../src/runtime.ts";
import { getText, setSetting } from "../../src/settings.ts";
import { WAKE_PATH, verifyWake } from "../../src/wake.ts";

// One small instance is plenty for one owner. The run queue still fences every
// write, since deploys overlap and scale.max isn't a hard guarantee.
export const config: Config = { size: "small", scale: { max: 1 } };

registerAssistant();
const app = new Hono();

app.onError((err, c) => {
  // A server's uncaught errors would otherwise send the stack trace to the visitor.
  console.error(`${c.req.method} ${c.req.path} failed`, err);
  return c.json({ error: "Something went wrong." }, 500);
});

app.get("/api/health", (c) => {
  c.header("cache-control", "no-store");
  return c.json({
    ok: true,
    build: BUILD_ID,
    instance: INSTANCE_ID,
    uptime: Math.round((Date.now() - STARTED_AT.getTime()) / 1000),
    // Which deploy answered, hashed. A draining instance compares it with its own (src/runtime.ts).
    deploy: deployHash(getContext().deploy.id),
  });
});

app.post(WEBHOOK_PATH, telegramWebhook);

// The scheduled function calls this when something is due. Signed with the wake key from the database.
let wakeSecret: string | undefined;
app.post(WAKE_PATH, async (c) => {
  if (!isLiveDeploy()) return c.json({ error: "This isn't the live deploy." }, 409);
  const db = getDb();
  wakeSecret ??= (await getText(db, "wake_secret")) ?? undefined;
  if (!wakeSecret || !verifyWake(wakeSecret, c.req.header("x-wake-ts"), c.req.header("x-wake-sig"))) {
    return c.json({ error: "Forbidden" }, 403);
  }
  await setSetting(db, "wake_last", new Date().toISOString());
  console.log(`[wake] instance ${INSTANCE_ID}, up ${Math.round((Date.now() - STARTED_AT.getTime()) / 1000)} s`);
  startDrain();
  return c.json({ accepted: true, instance: INSTANCE_ID }, 202);
});

if (process.env.PROBE_TOKEN) app.route("/probe", registerProbe());
app.route("/api", api);

app.notFound((c) => c.json({ error: "Not found" }, 404));

onShutdown(async ({ drained }) => {
  const at = Date.now();
  console.log(`[shutdown] instance ${INSTANCE_ID} (build ${BUILD_ID}) started shutting down; running: ${hasQueue() ? getQueue().activeRuns() : []}`);
  // Streams end so their clients reconnect to the new instance.
  closeStreams();
  if (hasQueue()) await getQueue().shutdown(60_000);
  await drained;
  await closeDb();
  console.log(`[shutdown] instance ${INSTANCE_ID} done after ${Math.round((Date.now() - at) / 1000)} s`);
});

export default app;
