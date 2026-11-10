# AGENTS.md

This is a personal AI assistant on Netlify Server: one owner, who talks to it on Telegram or in the web console on the same site. The README explains what it does and how it works. This file is for changing it.

## Commands

- `npm test` runs the tests against Postgres 18, which it starts in Docker, so Docker has to be running.
- `npm run typecheck` runs `tsc`.
- `npm run db:generate` writes a migration to `netlify/database/migrations` after you change `db/schema.ts`. Netlify applies migrations before each production deploy's server starts. Prefer additive changes.
- Running it locally is described in the README.

## Where things are

- `netlify/server/index.ts`: the server (Hono). Routes for Telegram's webhook, the wake call and the console's API.
- `netlify/functions/wake.mts`: the scheduled function that wakes the server when something is due.
- `src/queue.ts`: the run queue (claims, leases, recorded actions, the outbox).
- `src/app.ts`: what the queue runs: run kinds, senders and reply routing.
- `src/assistant.ts`: registers the assistant's run kinds, the Telegram sender and where replies go.
- `src/agent.ts`: the agent loop and the system prompt.
- `src/tools/`: the tools, one file per group, listed in `src/tools/index.ts`.
- `src/spend.ts`: the spend guard.
- `src/channels/`: Telegram.
- `src/console.ts` and `public/`: the console's API (documented in `docs/console-api.md`) and its single page, plain HTML and JavaScript with no build step.
- `src/personas.ts`, `src/settings.ts`: personas and the owner's settings.
- `src/probe.ts` and `test/platform/`: the platform tests, mounted only when `PROBE_TOKEN` is set.

## Rules to keep

Any change has to keep these:

1. Every change a run makes goes through the queue's `act()`, so it's recorded and a retry replays it instead of doing it again. In a tool, that means writing a change tool.
2. Messages go out only through the outbox, as deliveries. Never send from a run directly.
3. Every paid call reserves its worst case first and settles the real cost after (`reserve` and `settle` in `src/spend.ts`).
4. A tool that returns text from outside (the web, a forwarded message, another service) marks it `outside: true`. After that, change tools in the same run turn into proposals for the owner to confirm.
5. Only the live production deploy acts. Routes that change data or send messages check `isLiveDeploy()`.
6. There's one owner. A channel maps each sender to the owner and refuses everyone else.
7. The model never gets a way to read environment variables or files, and secrets never appear in a tool's result.

## Adding a tool

1. Write a file in `src/tools/` that exports a read tool or a change tool, with the types in `src/tools/types.ts`. `src/tools/history.ts` has read tools, and `src/tools/memory.ts` has change tools.
2. List it in `src/tools/index.ts`. Keep the order stable, since it affects prompt caching.
3. If it calls a paid API, follow `src/tools/search.ts`: reserve, call with the run's abort signal, then settle.
4. If the model needs to know when to use it, add a line to the system prompt in `src/agent.ts`.
5. Add tests in `test/`, against the real database like the existing ones.

## Adding a channel

Follow `src/channels/telegram.ts` and `src/channels/telegram-webhook.ts`:

1. Verify each request before anything else (a signature or a secret).
2. Map the sender to the owner, and refuse anyone else.
3. Record the message and its run in one transaction with `getQueue().ingest()`, then answer the request. The run happens after.
4. Register a sender in `senders` (`src/app.ts`) that delivers one outbox entry, and route replies to it in `route()` in `src/assistant.ts`.

## Before you finish

- Run `npm run typecheck` and `npm test`.
- Update the README, `docs/console-api.md` or the How it works page (`public/how-it-works.html`) when what they describe changes.
- If you changed the queue, run the platform tests in `test/platform/check.mjs` on a deploy that isn't used for anything else (see `docs/checks.md`).
