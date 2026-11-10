# Platform checks

We ran these on a production deploy on Nov 9-10, 2026, to see whether the run queue keeps its promises on Netlify Server: every message answered once, and every change made once, through crashes, deploys and idle stops. The deploy ran on one small instance (`scale.max` 1).

The harness is `src/probe.ts`, which the server mounts only when `PROBE_TOKEN` is set. A probe message is a run that takes N seconds, makes one change half way (recorded in `actions`), and answers on a "probe" channel that logs every send attempt. The driver is `test/platform/check.mjs`. A run passes when it's done, its change happened once, and it was sent once (or more, with every repeat marked as a resend).

## 1. Crash mid-run: passed

Two 30-second messages in one chat. The instance was killed with SIGKILL 19 s in, after the first run's change had committed.
- The first run was reclaimed as attempt 2 about 100 s after the crash: its lease (90 s from the claim, since no heartbeat had come yet) plus the next minute's wake.
- The retry replayed the change instead of making it again (1 effect, 1 `actions` row), and both messages were answered once, by the new instance, 150 s and 180 s after they were sent.

We ran it four times in all, after each round of fixes to the queue, and it recovered the same way each time. The later runs also checked that the crash hit the running message and that another instance reclaimed it.

## 2. Deploy mid-run: passed

Two 150-second messages, then a production deploy 10 s in (live at 38 s).
- The old instance got SIGTERM 62 s after the publish. `onShutdown` stopped new claims and waited. The first run finished on the old instance 52 s later, inside the 60 s grace, and was answered from there.
- The old instance claimed nothing more after SIGTERM. The second run waited for the next minute's wake (12 s after the first run finished) and ran on the new instance, which had been started at the publish.
- Each message was answered once, and each change made once.

Since then, a draining instance checks which deploy the production URL serves before each claim. With three 60-second messages, the old instance finished the first one, found the new deploy live and stopped taking work, 38 s before its SIGTERM. The new instance ran the other two at the next wake, each answered once. Right after the publish, messages posted to the old deploy's permalink got a `409`.

## 3. Idle mid-schedule: passed

A probe schedule due in 7 minutes, and no requests at all until it should have been done.
- The instance stopped 300 s after the last request. Two minutes later the schedule came due, the wake function's next run found it 4 s after that, and its call started a new instance (202 in 1.12 s, against 0.16-0.19 s when the server is up).
- The schedule turned into one run, which was answered once, from the new instance.

## 4. Answering a message from cold: passed

The probe's message route does what the Telegram webhook does: verify, then one transaction that records the inbound event, the user's message and the run, then answer and drain in `waitUntil`.
- After 5.5 idle minutes (the instance had stopped), a message got its `200` in 1.55 s, of which the transaction took 128 ms. The same request warm took 0.69 s.
- The database was never cold, because the wake function queries it every minute. A suspended database would add a few seconds to the first query, which is still well within what Telegram waits for.
- Through Telegram (Nov 10, 2026): after the server had been idle for over an hour, a message was recorded 1 s after it was sent (Telegram's clock, in whole seconds), by an instance that had been up for 1 s. Telegram reported no webhook errors.

Not tested on the platform: a retry of an update that arrives while its run is still going (the queue tests cover the duplicate key).

## 5. Streaming a run through a deploy: passed

One 240-second probe run, followed over server-sent events (`/api/runs/:id/events`) by a client that reconnects with `Last-Event-ID` the way the console does, and a production deploy 16 s in (live at 43 s).
- At SIGTERM (105 s, 62 s after the publish), `onShutdown` closed the stream, and the client was connected to the new instance 1 s later. That instance doesn't have the run's events, so it polled the database.
- The old instance kept running the run for the 60 s grace, then aborted it without releasing the lease. When the lease ran out, the next wake had the new instance reclaim it (at 248 s, attempt 2), and its events streamed live to the already reconnected client.
- The change made in attempt 1 was replayed, not repeated. The client got one final answer, and the reply was sent once.
- The events that seemed to pause between 16 s and 43 s were the test client itself, blocked while it ran the deploy.

So the console can rely on this: reconnect on any end, resume from the last event id, and the finished answer always arrives from whichever instance answers.

## 6. Web search

Anthropic's hosted search ranks a site's own pages poorly, which matters because the hosted fetch only opens URLs that already appeared in the conversation. So we ran the same queries through the three search engines the AI Gateway reaches (Nov 9, 2026):

| Query | Anthropic hosted search | OpenRouter, Exa engine | Gemini with Google Search |
|---|---|---|---|
| "Hacker News" | thehackernews.com, Wikipedia; no news.ycombinator.com | news.ycombinator.com first | Wikipedia, thehackernews.com, hckrnews.com |
| "hacker news front page" | articles about the front page | news.ycombinator.com, then /front | articles |
| "Netlify blog" | old posts and templates; no index | netlify.com/blog/ first | netlify.com (no URL) |

Gemini's list is what the model chose to cite, not Google's ranking, and its links are redirects, so it isn't a fair test, and it couldn't feed the fetch anyway. OpenRouter's `plugins: [{ id: "web", engine: "exa" }]` form always searches, took 2.6-3.5 s, cost about $0.007 with `usage.cost` reported, and returned up to about 3,000 characters of page text per result.

So the assistant has its own `web_search` on that plugin (`src/tools/search.ts`, with `gpt-oss-20b` cut at 16 tokens, since only the plugin's results matter), and keeps Anthropic's hosted fetch, which accepts URLs from our tool's results. The hosted fetch also refuses some sites, for example because of their `robots.txt`.
