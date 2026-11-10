import type { Context } from "hono";
import { CONVERSATION, isCommand } from "../assistant.ts";
import { getDb, transaction } from "../db.ts";
import { isLiveDeploy } from "../live.ts";
import { insertDeliveries } from "../queue.ts";
import { getQueue, startDrain } from "../runtime.ts";
import { getSettings } from "../settings.ts";
import { pairOwner, pickPhoto, refuseStranger, tg, type TgUpdate, verifyWebhook } from "./telegram.ts";

const WELCOME = `You're connected. I'm your assistant, and from now on I'll reach you here too: reminders, briefs and anything you schedule.

Tell me a bit about yourself and where you're based, or send /help to see what I can do.`;

/** Telegram's webhook: verify, map the sender to the owner, then record the update and its run in one transaction. */
export async function telegramWebhook(c: Context) {
  if (!verifyWebhook(c.req.header("x-telegram-bot-api-secret-token"))) return c.json({ error: "Forbidden" }, 403);
  if (!isLiveDeploy()) return c.json({ error: "This isn't the live deploy." }, 409);
  const update = (await c.req.json().catch(() => null)) as TgUpdate | null;
  if (!update || typeof update.update_id !== "number") return c.text("ok");
  const db = getDb();
  const owner = (await getSettings(db)).telegram;
  const key = `update:${update.update_id}`;

  // The Confirm and Discard buttons on a proposal.
  const cq = update.callback_query;
  if (cq) {
    const m = /^p:(\d+):(confirm|discard)$/.exec(cq.data ?? "");
    if (owner && cq.from.id === owner.userId && m) {
      const r = await getQueue().ingest({
        channel: "telegram",
        key,
        conversationId: CONVERSATION,
        kind: "proposal",
        origin: "telegram",
        input: { proposalId: Number(m[1]), decision: m[2] },
      });
      if (r.drain) startDrain();
    }
    await tg("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});
    return c.text("ok");
  }

  const msg = update.message;
  if (!msg?.from || msg.from.is_bot || msg.chat.type !== "private") return c.text("ok");
  const text = (msg.text ?? msg.caption ?? "").trim();
  const isOwner = owner?.userId === msg.from.id;

  // Pairing: "/start <token>" from the one-time link the console makes.
  const start = /^\/start\s+([0-9a-f]{32})$/.exec(text);
  if (start) {
    const paired = await transaction(db, async (tx) => {
      if (!(await pairOwner(tx, start[1], msg))) return false;
      await insertDeliveries(tx, null, [{ channel: "telegram", destination: String(msg.chat.id), text: WELCOME }]);
      return true;
    });
    if (paired) startDrain();
    else if (!isOwner) await refuseStranger(db, msg);
    return c.text("ok");
  }
  if (!isOwner) {
    await refuseStranger(db, msg);
    return c.text("ok");
  }

  const photo = pickPhoto(msg);
  const unsupported = !text && !photo;
  const forwarded = Boolean(msg.forward_origin);
  // A forwarded message is outside text, even when it looks like a command.
  const kind = unsupported || (!photo && !forwarded && isCommand(text)) ? "command" : "message";
  const r = await getQueue().ingest({
    channel: "telegram",
    key,
    conversationId: CONVERSATION,
    kind,
    origin: "telegram",
    input: kind === "command" ? { text: unsupported ? "/unsupported" : text } : { text, photoFileId: photo, forwarded },
    message: {
      content: text || (photo ? "(photo)" : "(something I can't read yet)"),
      meta: photo || forwarded ? { ...(photo ? { photo: true } : {}), ...(forwarded ? { forwarded: true } : {}) } : undefined,
    },
  });
  if (r.drain) startDrain();
  // How long after sending it the message was safely recorded (whole seconds, from Telegram's
  // clock), and how long this instance has been up, so a cold start shows in the logs.
  console.log(`telegram update ${update.update_id}: recorded ${Math.round(Date.now() / 1000 - (msg.date ?? 0))} s after sending, instance up ${Math.round(process.uptime())} s`);
  return c.text("ok");
}
