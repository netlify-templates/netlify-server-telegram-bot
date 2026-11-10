# Netlify Server-based Telegram Bot

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/netlify-templates/netlify-server-telegram-bot)

This is a small starter for your own AI assistant, running on your own Netlify site. You talk to it on Telegram or in a web console on the same site. It remembers things about you, reminds you, watches pages for changes and searches the web. It's meant to be deployed in minutes and read in an hour, and then changed to fit what you need.

**Everything runs on Netlify, with no AI API keys to manage.** [Netlify Server](https://docs.netlify.com/build/server/) runs the assistant, Netlify Database keeps its memory, schedules and history, the AI Gateway provides Claude and web search, and a scheduled function wakes the server up when something is due.

## What it can do

- Chat on Telegram and in the console. It's one conversation across both, so "remind me" in the console reminds you on Telegram. In the console, replies stream in as they're written.
- Remember facts about you as short notes (up to 400 characters each and 6,000 in total), which it sees in every message. Every change it makes is announced with its undo, like "📝 Noted: you're vegetarian (/forget 12)".
- Reminders and schedules in your time zone: once, daily at a time (on all days or some weekdays), or every few hours. A schedule can also watch something and only speak up when it changed. The console has three ready-made ones: a morning brief, watching a page, and telling you when a site is down.
- Search the web and read pages.
- Search your past conversations ("what was that restaurant you suggested in March?").
- Read photos.
- Take on one of three personas: Juniper (calm and practical), Marlow (warm, with a light touch of humor) or Quill (witty and opinionated). You can rename it and rewrite its personality in the console, or just ask it to change.

## Deploy your own

You'll need a Netlify team that can deploy Netlify Server.

1. Deploy the repo with the button at the top. Netlify creates the site's database on the first deploy, and the migrations set up its tables.
2. Set a password for the console. The console stays off until `CONSOLE_PASSWORD` is set to at least 16 characters. The easiest way is to start an Agent Run on the project in the Netlify UI, with this prompt (the site's setup page shows it too, with a Copy button):
   > Generate a secure password for this project's console. Show it to me and help me set it as an environment variable named CONSOLE_PASSWORD, marked as secret. Remind me to save the password somewhere safe, and to publish the changes!

   Or set it yourself and redeploy. From the CLI, in the project's folder:
   ```bash
   netlify env:set CONSOLE_PASSWORD <password> --context production --secret
   ```
3. Open the site and sign in. In Settings, set your time zone (or just tell the assistant where you live) and pick a persona.

## Connect Telegram

1. In Telegram, message @BotFather (the one with the blue check), send `/newbot`, and pick a name and a username that ends in `bot`. BotFather replies with your bot's token.
2. Set the token as `TELEGRAM_BOT_TOKEN`, then redeploy:
   ```bash
   netlify env:set TELEGRAM_BOT_TOKEN <token> --context production --secret
   ```
3. Open the console's Status page, which connects the bot to your site. Click "Connect Telegram", open the link where you use Telegram, and press Start. The link works once, for 15 minutes.

From then on, the bot only talks to you. Anyone else who messages it gets one polite refusal, and then silence. In Telegram, `/new` starts a fresh conversation (memory is kept), and `/help` lists what it can do.

Before you connect Telegram, reminders and reports show up in the console, and as a browser notification while the console is open.

## What it costs

- The model is Claude Sonnet 5.5 by default. Haiku 5.5 is a cheaper option in Settings.
- A web search costs about $0.007. Reading a page has no fee of its own, only the tokens it adds.
- There's a daily spending cap, $2 by default, which you can change in Settings. Before each model call and each search, the assistant sets aside the most that call could cost, and if that would pass the cap, it doesn't make the call. Close to the cap, it answers without the web. A scheduled job that hits the cap waits for the next day.
- The cap can be passed only by usage the API doesn't report back, or by a large PDF read in one go (the limit on page size doesn't cover PDFs).

For a sense of scale, a day of testing on Nov 9, 2026 (14 messages, most of them with web searches, plus a few reminders) cost $0.57 on Sonnet 5.5. [Netlify Server and Database costs TBD]

## How it works

This part is for anyone curious about what happens under the hood. The site's How it works page (`/how-it-works`) covers the same ground, with a diagram. There are a few parts to this repo:

1. The assistant. `src/agent.ts` is the loop (Claude, tools, up to 10 rounds per message, and the spend reservations), and `src/tools/` has the tools, one file per group.
2. The run queue in `src/queue.ts`, which makes sure every message gets an answer through deploys, crashes and idle stops.
   1. A Telegram message is saved in the database, together with the run that will answer it, before Telegram gets its OK.
   2. A run holds a lease that it renews every 30 seconds. If its instance dies, another one picks the run up after the lease runs out (90 seconds).
   3. Whatever a run already did (a note saved, a schedule created) is recorded, so a retry doesn't do it again.
   4. Replies go out through an outbox. If a reply might have been sent already, the retry says so.
   5. When a new deploy goes live, the old instance stops taking new work right away, and gets 60 seconds to finish what it's running.
3. The console: one page in `public/` (plain HTML and JavaScript, no build step), and the JSON API it talks to in `src/console.ts`, documented in `docs/console-api.md`.
4. Telegram, in `src/channels/`.
5. Waking up. `netlify/functions/wake.mts` runs every minute, checks the database for anything due, and calls the server only when there's work. So the server can stop when it's idle and still send your 8:00 brief.

The server itself is `netlify/server/index.ts`, a Hono app on one small instance. `docs/checks.md` has the platform tests we ran on it: killing the instance mid-run, deploying mid-run, streaming through a deploy, schedules on an idle server, and answering from cold.

## Safety

- It has one owner. Telegram pairs only through a one-time link from the console, and the console needs the password, with failed attempts throttled.
- The assistant can't act in the world beyond messaging you, remembering things and scheduling.
- Text from the web or from a forwarded message can't change anything on its own. Once a message's run has read such text, changes to notes, schedules or the persona become proposals, which you confirm with a button in Telegram or the console. Scheduled jobs can read and report, but never change anything.
- Only the published production deploy acts. An old deploy's permalink or a preview gets a 409, instead of touching your data or sending messages.
- No tool reads environment variables or files, so your tokens and password never reach the model.

## Things to know

- Pages are read with Anthropic's hosted fetch. It only opens addresses that you wrote or that came back from a search, it doesn't run JavaScript, and some sites refuse it (for example, because of their `robots.txt`).
- Search goes through OpenRouter's Exa engine on the AI Gateway. Without it, the assistant falls back to Anthropic's hosted search, which is worse at finding a site's own pages (see check 6 in `docs/checks.md`).
- Every message is answered at least once. In rare cases, like a crash while sending, a reply can arrive twice, and then the second one says it's a resend.
- The wake function's query every minute keeps Netlify Database's compute from suspending. [Keep it, or move the check to Netlify Blobs? TBD]
- It's built for one person.

## Changing it

- A tool is one file in `src/tools/`, exporting a read tool or a change tool (see `src/tools/types.ts`), and listed in `src/tools/index.ts`. Change tools run through the queue, so they're recorded, safe to retry, and turned into proposals after outside text, without extra work in the tool.
- A channel has to verify each request first, map the sender to the owner, and send only through the outbox. `src/channels/telegram.ts` is the example to follow.
- [Recipes (a Netlify tool, voice notes, Slack and others) and an AGENTS.md: TBD]

## Running it locally, and tests

- `npm test` runs the tests against Postgres 18, which it starts in Docker, so it needs Docker running.
- To run the server locally, start a Postgres and apply the migrations with `scripts/local-db.ts` (the steps are at the top of the file), then run `netlify dev` with `LOCAL_MODE=1` and `DATABASE_URL` set. Locally, `netlify dev` may not get the AI Gateway's variables, in which case set `ANTHROPIC_API_KEY` yourself.
- `test/platform/check.mjs` runs the platform tests against a deployed site. They need `PROBE_TOKEN` set on the site, which turns on test routes, so don't set it on a site you rely on.

## More

- [Netlify Server docs](https://docs.netlify.com/build/server/): the platform's documentation.
- `docs/checks.md`: what we measured on the platform.
- `docs/console-api.md`: the console's API.

## License

MIT, see [LICENSE](LICENSE).
