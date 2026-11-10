import { createHash } from "node:crypto";
import { getContext } from "@netlify/server";
import { getSecret } from "./settings.ts";
import { signWake, WAKE_PATH } from "./wake.ts";
import { app } from "./app.ts";
import { getDb } from "./db.ts";
import { publish } from "./events.ts";
import { createQueue, type Queue } from "./queue.ts";

let queue: Queue | undefined;

/** A deploy id, hashed: enough to compare deploys without handing out permalinks. */
export const deployHash = (deployId: string) => createHash("sha256").update(`deploy:${deployId}`).digest("hex").slice(0, 16);

// Before each claim, schedule and send, a draining instance checks that its
// deploy is still the one the site's production URL serves. A request's
// `published` flag only describes that request, and an instance a new deploy
// replaced would otherwise keep taking work until its SIGTERM a minute later.
// A check that fails counts as "no": the work waits for the next wake, and a
// site whose production URL can't be fetched couldn't take webhooks anyway.
let drainingFor: { siteUrl: string; deploy: string } | undefined;

async function stillPublished(): Promise<boolean> {
  if (process.env.LOCAL_MODE === "1") return true;
  if (!drainingFor) return false;
  try {
    const res = await fetch(new URL("/api/health", drainingFor.siteUrl), { signal: AbortSignal.timeout(5_000) });
    const body = (await res.json()) as { deploy?: string };
    if (body.deploy === drainingFor.deploy) return true;
    console.log("A newer deploy serves the site now; this instance stops taking work");
    handOver(drainingFor.siteUrl);
  } catch (err) {
    console.warn("Couldn't check which deploy is live; not taking work until the next wake", err instanceof Error ? err.message : err);
  }
  return false;
}

/** Wakes the new deploy, so it takes over now instead of at the next minute's wake. */
let handedOver = false;
function handOver(siteUrl: string): void {
  if (handedOver) return;
  handedOver = true;
  void (async () => {
    const ts = Math.floor(Date.now() / 1000);
    const secret = await getSecret(getDb(), "wake_secret");
    await fetch(new URL(WAKE_PATH, siteUrl), {
      method: "POST",
      headers: { "x-wake-ts": String(ts), "x-wake-sig": signWake(secret, ts) },
      signal: AbortSignal.timeout(10_000),
    });
  })().catch((err) => console.warn("Couldn't wake the new deploy", err instanceof Error ? err.message : err));
}

/** The instance's queue, created on first use so a missing database fails a request, not the deploy. */
export function getQueue(): Queue {
  queue ??= createQueue({
    db: getDb(),
    app,
    mayAcquire: stillPublished,
    onEvent: (run, event) => publish(run.id, run.attempt, event),
  });
  return queue;
}

export const hasQueue = () => queue !== undefined;

/** Drains in the background. Call it only from a request that passed isLiveDeploy(). */
export function startDrain(): void {
  const ctx = getContext();
  drainingFor = { siteUrl: ctx.site.url ?? "", deploy: deployHash(ctx.deploy.id) };
  ctx.waitUntil(getQueue().drain());
}
