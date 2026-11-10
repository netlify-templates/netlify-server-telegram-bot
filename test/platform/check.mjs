#!/usr/bin/env node
// The run queue's platform test (docs/checks.md), against a
// deployed site with PROBE_TOKEN set. Each probe message is a run that takes
// `seconds`, makes one fenced change half way, and answers on the "probe"
// channel. A run passes when it's done, its change happened once, and it was
// sent once, or more than once with every repeat marked as a resend.
//
//   SITE=https://<site>.netlify.app PROBE_TOKEN=... node test/platform/check.mjs <command>
//
// Commands:
//   report                 print the probe runs
//   reset                  delete probe data
//   crash [seconds]        2 messages, SIGKILL the instance mid-run, wait for both answers
//   deploy [secs] [count]  messages (2 by default), deploy to production mid-run, wait for all answers
//   schedule [in] [secs]   a probe schedule due in `in` seconds, then no requests until it should be done
//   sse <runId>            follow a run's events, reconnecting like the console will
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const SITE = process.env.SITE?.replace(/\/$/, "");
const TOKEN = process.env.PROBE_TOKEN;
if (!SITE || !TOKEN) {
  console.error("Set SITE and PROBE_TOKEN");
  process.exit(2);
}
const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s]`;
const log = (...a) => console.log(stamp(), ...a);

async function api(path, body) {
  const res = await fetch(SITE + path, {
    method: body ? "POST" : "GET",
    headers: { "x-probe-token": TOKEN, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try {
    return { status: res.status, ...JSON.parse(text) };
  } catch {
    return { status: res.status, text };
  }
}

function verdict(run) {
  const sends = run.sends ?? [];
  const repeatsMarked = sends.slice(1).every((s) => s.resend);
  const ok =
    (run.state === "done" && run.effects === 1 && sends.length >= 1 && repeatsMarked) ||
    (run.state === "failed" && run.effects <= 1 && sends.length >= 1 && repeatsMarked);
  return { ok, sends: sends.length, repeatsMarked };
}

function printReport(r) {
  log(`instance ${r.instance}, active ${JSON.stringify(r.active)}, chat ${JSON.stringify(r.conversation)}`);
  for (const run of [...r.runs].reverse()) {
    const v = verdict(run);
    const instances = [...new Set(run.sends.map((s) => s.instance))].join(",");
    console.log(
      `  run ${run.id} ${run.label}: ${run.state}, attempt ${run.attempt}, effects ${run.effects}, ` +
        `sends ${v.sends}${run.sends.some((s) => s.resend) ? " (resend marked)" : ""} from ${instances || "-"}` +
        `${run.error ? `, error "${run.error}"` : ""} -> ${v.ok ? "PASS" : run.state === "done" || run.state === "failed" ? "FAIL" : "waiting"}`,
    );
  }
}

async function waitForAll(keys, timeoutS, intervalS = 15) {
  const deadline = Date.now() + timeoutS * 1000;
  for (;;) {
    const r = await api("/probe/report");
    const mine = (r.runs ?? []).filter((x) => keys.includes(x.key));
    const finished = mine.filter((x) => x.state === "done" || x.state === "failed");
    log(`${finished.length}/${keys.length} finished; ${mine.map((x) => `${x.id}:${x.state}/${x.attempt}`).join(" ")}`);
    if (finished.length === keys.length && mine.every((x) => x.sends.length > 0)) {
      printReport({ ...r, runs: mine });
      return mine.every((x) => verdict(x).ok);
    }
    if (Date.now() > deadline) {
      printReport({ ...r, runs: mine });
      return false;
    }
    await sleep(intervalS * 1000);
  }
}

async function send(label, seconds, count = 2) {
  const r = await api("/probe/message", { label, seconds, count });
  if (r.status !== 200) throw new Error(`probe/message: ${r.status} ${JSON.stringify(r)}`);
  log(`sent ${count} x ${seconds} s to instance ${r.instance} (ingest ${r.ingestMs} ms): runs ${r.runs.map((x) => x.runId).join(", ")}`);
  return r.runs.map((x) => x.key);
}

function publishedDeployId() {
  const siteId = JSON.parse(execFileSync("cat", [".netlify/state.json"], { encoding: "utf8" })).siteId;
  const site = JSON.parse(execFileSync("netlify", ["api", "getSite", "--data", JSON.stringify({ site_id: siteId })], { encoding: "utf8" }));
  return site.published_deploy?.id;
}

/** An old deploy's permalink reaches the same database, so it must refuse to change anything. */
async function oldPermalinkRefuses(deployId) {
  const base = SITE.replace("https://", `https://${deployId}--`);
  let ok = true;
  for (const path of ["/probe/message", "/probe/reset"]) {
    const res = await fetch(base + path, {
      method: "POST",
      headers: { "x-probe-token": TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ seconds: 1, label: "from an old permalink" }),
    });
    log(`old permalink ${path}: ${res.status}`);
    if (res.status !== 409) ok = false;
  }
  return ok;
}

const [cmd, ...args] = process.argv.slice(2);

if (cmd === "report") printReport(await api("/probe/report"));
else if (cmd === "reset") log(await api("/probe/reset", {}));
else if (cmd === "crash") {
  const seconds = Number(args[0] ?? 30);
  const keys = await send("crash", seconds);
  await sleep((Math.ceil(seconds / 2) + 3) * 1000); // after the first run's change
  const before = (await api("/probe/report")).runs.find((x) => x.key === keys[0]);
  const c = await api("/probe/crash", {});
  log(`crashed instance ${c.instance} with runs ${JSON.stringify(c.active)} active`);
  // Make sure the crash really hit the instance running the first message.
  if (c.status !== 200 || !c.active?.includes(before?.id)) {
    log(`FAIL: the crash didn't hit the running message (status ${c.status}, active ${JSON.stringify(c.active)}, run ${before?.id})`);
    process.exit(1);
  }
  await sleep(5000);
  let ok = await waitForAll(keys, 600);
  const after = (await api("/probe/report")).runs.find((x) => x.key === keys[0]);
  if (!(after.attempt >= 2 && after.sends.every((x) => x.instance !== c.instance))) {
    log(`FAIL: the crashed run wasn't reclaimed by another instance (attempt ${after.attempt})`);
    ok = false;
  }
  log(ok ? "PASS: each message answered once (or with the resend note), each change made once" : "FAIL");
  process.exit(ok ? 0 : 1);
} else if (cmd === "deploy") {
  const seconds = Number(args[0] ?? 60);
  const keys = await send("deploy", seconds, Number(args[1] ?? 2));
  await sleep(10_000);
  const oldDeploy = publishedDeployId();
  log("deploying to production (with a new DEPLOY_MARK so the server gets a new instance)");
  execFileSync("netlify", ["env:set", "DEPLOY_MARK", String(Date.now())], { stdio: "ignore" });
  execFileSync("netlify", ["deploy", "--prod", "--message", `queue check: deploy mid-run (${seconds} s runs)`], { stdio: "ignore" });
  log("deploy is live");
  let ok = await oldPermalinkRefuses(oldDeploy);
  ok = (await waitForAll(keys, 900)) && ok;
  if (keys.length >= 3) {
    // The run that was still queued at the publish must run on the new deploy.
    const runs = (await api("/probe/report")).runs.filter((x) => keys.includes(x.key)).sort((a, b) => a.id - b.id);
    const first = runs[0].sends[0]?.instance;
    const last = runs.at(-1).sends[0]?.instance;
    if (!first || first === last) {
      log(`FAIL: the last run ran on the old instance too (${first})`);
      ok = false;
    } else log(`handoff: first run on ${first}, last run on ${last}`);
  }
  log(ok ? "PASS: each message answered once (or with the resend note), each change made once" : "FAIL");
  process.exit(ok ? 0 : 1);
} else if (cmd === "schedule") {
  const inSeconds = Number(args[0] ?? 420);
  const seconds = Number(args[1] ?? 30);
  const s = await api("/probe/schedule", { inSeconds, seconds });
  log(`schedule ${s.id} due at ${s.next_run_at}; no requests until it should be done`);
  // Any request resets the idle timer, so stay away until the run should be over.
  await sleep((inSeconds + 60 + seconds + 90) * 1000);
  const r = await api("/probe/report");
  const runs = r.runs.filter((x) => x.label === `schedule ${s.id}`);
  printReport({ ...r, runs });
  const ok = runs.length === 1 && verdict(runs[0]).ok;
  log(ok ? "PASS: the schedule ran once and was answered once" : "FAIL");
  process.exit(ok ? 0 : 1);
} else if (cmd === "sse") {
  process.exit((await follow(args[0])) ? 0 : 1);
} else if (cmd === "stream-deploy") {
  const seconds = Number(args[0] ?? 150);
  const [key] = await send("stream", seconds, 1);
  const run = (await api("/probe/report")).runs.find((x) => x.key === key);
  setTimeout(() => {
    log("deploying to production mid-stream");
    execFileSync("netlify", ["env:set", "DEPLOY_MARK", String(Date.now())], { stdio: "ignore" });
    execFileSync("netlify", ["deploy", "--prod", "--message", `queue check: deploy mid-stream (${seconds} s run)`], { stdio: "ignore" });
    log("deploy is live");
  }, 15_000);
  const answer = await follow(run.id);
  const ok = await waitForAll([key], 300, 10);
  log(ok && answer ? `PASS: the stream showed the finished answer: ${answer}` : "FAIL");
  process.exit(ok && answer ? 0 : 1);
} else {
  console.error("Unknown command. See the comment at the top of this file.");
  process.exit(2);
}

/** Follows a run's events like the console will: reconnect on any end, resume with Last-Event-ID. Returns the answer. */
async function follow(runId) {
  let lastId;
  for (let attempt = 1; attempt <= 30; attempt++) {
    const headers = { "x-probe-token": TOKEN, accept: "text/event-stream" };
    if (lastId) headers["last-event-id"] = lastId;
    log(`connecting${lastId ? ` (last event ${lastId})` : ""}`);
    try {
      const res = await fetch(`${SITE}/api/runs/${runId}/events`, { headers });
      const decoder = new TextDecoder();
      let buffer = "";
      let finished = false;
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const fields = Object.fromEntries(
            block.split("\n").filter((l) => l && !l.startsWith(":")).map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]),
          );
          if (!fields.event && !fields.data) continue;
          if (fields.id) lastId = fields.id;
          if (fields.event !== "tick" || fields.data.includes('"i":1,') || /"i":\d*0,/.test(fields.data)) {
            log(`${fields.event ?? "message"} ${fields.data ?? ""}`);
          }
          if (fields.event === "done" || fields.event === "failed") finished = JSON.parse(fields.data).text ?? fields.event;
        }
      }
      if (finished) return finished;
      log("stream ended without an answer; reconnecting");
    } catch (err) {
      log(`stream error: ${err.message}`);
    }
    await sleep(1000);
  }
  return null;
}
