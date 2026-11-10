# Console API

The console is one static page (`public/index.html`, `public/app.js`, `public/app.css`, no build step) that talks to the server's JSON API under `/api`. Everything is same-origin. Sign-in sets an `HttpOnly`, `SameSite=Strict` cookie, so the page never handles a token, and `EventSource` sends the cookie on its own.

Errors are JSON: `{ "error": "message" }`, with these statuses:
- `401` signed out;
- `409` "this isn't the live deploy" (an old deploy's permalink);
- `429` throttled, with `retryAfter` in seconds;
- `503` the console isn't configured (`CONSOLE_PASSWORD` missing or shorter than 16 characters).

## Session

- `GET /api/session` → `{ signedIn: boolean, consoleEnabled: boolean, reason?: string }`
- `POST /api/login` `{ password }` → `{ ok: true }` and the cookie, or `401`, `429`, `503`
- `POST /api/logout` → `{ ok: true }`

Everything below needs the cookie.

## Chat

- `GET /api/messages?before=<id>&after=<id>&limit=<n>` → `{ messages: Message[], hasMore: boolean }`, oldest first. `before` pages back through history; `after` returns only newer messages (poll it every 15 s while the page is open to show scheduled reports).
  - `Message`: `{ id, role: "user" | "assistant" | "notice", content, createdAt, runId: number | null, meta: object | null }`. `notice` lines come from the server (failures, a paused schedule); show them muted. `meta.photo: true` on a user message means it had a photo. Assistant replies may end with change notices, one per line, like `📝 Noted: you're vegetarian (undo: forget note 12)`.
- `POST /api/chat` `{ text, image?: { mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif", data: <base64> }, clientId: <uuid> }` → `202 { runId }`. `clientId` makes a resend of the same message safe. Images up to 5 MB.
- `GET /api/runs/<runId>/events` is a server-sent event stream for one run. Reconnect on any end, with `Last-Event-ID` (`EventSource` does this itself; the server also closes streams on purpose during deploys). Events:
  - `hello` `{ instance }`: connected.
  - `start` `{ attempt }`: the run started (attempt 2 means it's a retry after an interruption).
  - `delta` `{ text }`: more of the reply; append it.
  - `tool` `{ name, label }`: a tool call, as a one-line note (`label` is human-readable, like "Searching the web").
  - `done` `{ text }`: the final reply, which replaces the streamed text. Close the stream.
  - `failed` `{ text }`: the run failed; show `text` as a notice. Close the stream.
  - `missing`: no such run. Close the stream.
  The final reply also lands in `/api/messages`, so a page that missed the stream still shows it.

## Proposals

Changes the assistant suggested after reading the web, waiting for the owner.

- `GET /api/proposals` → `{ proposals: [{ id, summary, createdAt, expiresAt }] }`
- `POST /api/proposals/<id>` `{ decision: "confirm" | "discard" }` → `202 { runId }` (follow it like a chat run)

Show pending proposals at the top of the chat with Confirm and Discard buttons.

## Memory

- `GET /api/notes` → `{ notes: [{ id, content, updatedAt }], used, limit }` (characters used of the total; each note is up to 400)
- `POST /api/notes` `{ content }` → `{ note }`
- `PUT /api/notes/<id>` `{ content }` → `{ note }`
- `DELETE /api/notes/<id>` → `{ ok: true }`

## Schedules

- `GET /api/schedules` → `{ schedules: Schedule[], limit: 10, templates: Template[] }`
  - `Schedule`: `{ id, instruction, mode: "notify" | "watch", rule, ruleText, nextRunAt: string | null, paused, failures, lastReport: string | null }`. `ruleText` is human-readable ("Weekdays at 08:00").
  - `Template`: `{ id, title, description, fields: [{ name, label, placeholder, required }] }`. The three starters: a weekday morning brief (city, topics), watching a page (URL, what to look for), and "tell me if my site is down" (URL).
- `POST /api/schedules` `{ template, fields }` → `{ schedule }`
- `PATCH /api/schedules/<id>` `{ paused: boolean }` → `{ schedule }`
- `DELETE /api/schedules/<id>` → `{ ok: true }`
- `POST /api/schedules/<id>/run` → `202 { runId }` ("run now")

## Settings

- `GET /api/settings` → `{ timezone, model, models: [{ id, label }], dailyCapUsd, persona: { preset, name, soul }, presets: [{ id, name, description }] }`
- `PUT /api/settings` with any of `{ timezone, model, dailyCapUsd, persona: { preset?, name?, soul? } }` → the settings

## Status

- `GET /api/status` →
  ```
  {
    build, instance,
    telegram: { configured, paired, botUsername, webhook: "connected" | "missing" | "elsewhere" | "unknown", lastError },
    wake: { lastCallAt },
    spend: { today, reserved, cap, days: [{ day, spent }] },
    runs: { queued, running, failedToday },
    deliveries: { failed: [{ id, text, lastError, createdAt }] }
  }
  ```
  On the live deploy, this also connects the bot's webhook when the token or the site's URL changed since it was last connected, so setting the token, redeploying and opening the console is all it takes. A failure to connect shows in `telegram.lastError`.
- `POST /api/deliveries/<id>/retry` → `{ ok: true }`
- `POST /api/telegram/pair` → `{ link, expiresAt }`: a one-time `t.me` link, valid 15 minutes. Show it with a copy button and a QR-free plain link.
- `POST /api/telegram/webhook` → `{ ok: true, url }`: points the bot at this site again, even if it seems connected (the Reconnect button).

Until Telegram is paired, show "Connect Telegram to get these anywhere" in the chat, linking to the status page.
