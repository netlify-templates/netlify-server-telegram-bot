import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { type Db, type Queryable, rowCount, rows } from "../db.ts";
import { RESEND_NOTE, type Sender } from "../queue.ts";
import { getSettings, getText, setSetting, type TelegramOwner } from "../settings.ts";

// The Telegram channel. It follows the channel contract:
// - verify the request first (Telegram's secret token header);
// - map the sender to the paired owner; anyone else gets one refusal, then
//   silence, and never reaches the conversation or the budget;
// - reply only to the owner's paired chat;
// - ingest with a channel-namespaced key (the update id) in the same
//   transaction as the run (the server's webhook route does this);
// - send only through the outbox (`sender` below is called by the queue).

export const WEBHOOK_PATH = "/telegram/webhook";
const API = "https://api.telegram.org";
const MAX_PART = 3_800; // Telegram allows 4,096; leave room for HTML tags
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

export const botToken = () => process.env.TELEGRAM_BOT_TOKEN ?? "";
export const telegramConfigured = () => botToken().length > 0;

/** The webhook's secret, derived from the bot token. Telegram allows [A-Za-z0-9_-], which hex is. */
export const webhookSecret = () => createHmac("sha256", botToken()).update("assistant:telegram-webhook").digest("hex");

export function verifyWebhook(header: string | undefined): boolean {
  if (!telegramConfigured() || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(webhookSecret());
  return a.length === b.length && timingSafeEqual(a, b);
}

export class TelegramError extends Error {
  method: string;
  status: number;
  description: string;
  constructor(method: string, status: number, description: string) {
    super(`Telegram ${method} failed (${status}): ${description}`);
    this.method = method;
    this.status = status;
    this.description = description;
  }
}

export async function tg<T = unknown>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${API}/bot${botToken()}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
  if (!res.ok || !data.ok) throw new TelegramError(method, res.status, data.description ?? "unknown error");
  return data.result as T;
}

// ---- Updates ---------------------------------------------------------------

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}
export interface TgMessage {
  message_id: number;
  date?: number; // unix seconds
  from?: TgUser;
  chat: { id: number; type: string };
  text?: string;
  caption?: string;
  photo?: { file_id: string; width: number; height: number; file_size?: number }[];
  forward_origin?: unknown;
  voice?: unknown;
  document?: unknown;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: { id: string; from: TgUser; data?: string; message?: TgMessage };
}

/** The largest photo size under 5 MB. */
export function pickPhoto(msg: TgMessage): string | undefined {
  const fits = (msg.photo ?? []).filter((p) => (p.file_size ?? 0) <= MAX_PHOTO_BYTES);
  return fits.sort((a, b) => b.width * b.height - a.width * a.height)[0]?.file_id;
}

export async function downloadPhoto(fileId: string): Promise<{ mediaType: "image/jpeg" | "image/png" | "image/webp"; data: string }> {
  const file = await tg<{ file_path?: string }>("getFile", { file_id: fileId });
  if (!file.file_path) throw new Error("Telegram returned no file path");
  const res = await fetch(`${API}/file/bot${botToken()}/${file.file_path}`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Photo download failed with ${res.status}`);
  const ext = file.file_path.split(".").pop()?.toLowerCase();
  return {
    mediaType: ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg",
    data: Buffer.from(await res.arrayBuffer()).toString("base64"),
  };
}

// ---- Pairing ---------------------------------------------------------------

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Makes a one-time pairing link, valid for 15 minutes. */
export async function createPairingLink(db: Db): Promise<{ link: string; expiresAt: string }> {
  const me = await tg<{ username: string }>("getMe");
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex"); // 128 bits
  const [row] = await rows<{ expires_at: string }>(
    db,
    sql`insert into pairing_tokens (token_hash, expires_at) values (${hashToken(token)}, now() + interval '15 minutes') returning expires_at`,
  );
  return { link: `https://t.me/${me.username}?start=${token}`, expiresAt: new Date(row.expires_at).toISOString() };
}

/** Uses up a pairing token and makes the sender the owner. False if the token isn't valid. */
export async function pairOwner(q: Queryable, token: string, msg: TgMessage): Promise<boolean> {
  const used = await rowCount(
    q,
    sql`update pairing_tokens set used_at = now()
        where token_hash = ${hashToken(token)} and used_at is null and expires_at > now()`,
  );
  if (used !== 1 || !msg.from) return false;
  const owner: TelegramOwner = { userId: msg.from.id, chatId: msg.chat.id, username: msg.from.username, firstName: msg.from.first_name };
  await setSetting(q, "telegram", owner);
  return true;
}

/** One polite refusal per stranger, then silence. Sent directly: a stranger has no place in the outbox. */
export async function refuseStranger(db: Db, msg: TgMessage): Promise<void> {
  if (!msg.from) return;
  const fresh = await rowCount(db, sql`insert into telegram_strangers (user_id) values (${msg.from.id}) on conflict do nothing`);
  if (fresh === 1) {
    await tg("sendMessage", { chat_id: msg.chat.id, text: "Sorry, I'm a private assistant and only talk to my owner." }).catch(() => {});
  }
}

// ---- Sending ---------------------------------------------------------------

export function splitText(text: string): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > MAX_PART) {
    let cut = rest.lastIndexOf("\n\n", MAX_PART);
    if (cut < MAX_PART / 2) cut = rest.lastIndexOf("\n", MAX_PART);
    if (cut < MAX_PART / 2) cut = rest.lastIndexOf(" ", MAX_PART);
    if (cut < MAX_PART / 2) cut = MAX_PART;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts.length ? parts : ["…"];
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The common Markdown the model writes, in Telegram's HTML subset. */
export function markdownToTelegramHtml(md: string): string {
  const blocks: string[] = [];
  let out = md.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code: string) => {
    blocks.push(`<pre>${escapeHtml(code.replace(/\n$/, ""))}</pre>`);
    return `\u0000B${blocks.length - 1}\u0000`;
  });
  const inline: string[] = [];
  out = out.replace(/`([^`\n]+)`/g, (_, code: string) => {
    inline.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000I${inline.length - 1}\u0000`;
  });
  out = escapeHtml(out)
    .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, "$1<i>$2</i>")
    .replace(/~~(.+?)~~/g, "<s>$1</s>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label: string, url: string) => `<a href="${url.replace(/"/g, "&quot;")}">${label}</a>`)
    .replace(/^(\s*)[-*]\s+/gm, "$1• ");
  return out.replace(/\u0000I(\d+)\u0000/g, (_, i) => inline[Number(i)]).replace(/\u0000B(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
}

type Buttons = { text: string; data: string }[];

async function sendPart(chatId: string, text: string, buttons: Buttons | undefined, signal: AbortSignal) {
  const extra = {
    link_preview_options: { is_disabled: true },
    ...(buttons ? { reply_markup: { inline_keyboard: [buttons.map((b) => ({ text: b.text, callback_data: b.data }))] } } : {}),
  };
  try {
    await tg("sendMessage", { chat_id: chatId, text: markdownToTelegramHtml(text), parse_mode: "HTML", ...extra }, signal);
  } catch (err) {
    // Formatting Telegram rejects (an unbalanced tag, say) shouldn't lose the reply.
    if (err instanceof TelegramError && err.status === 400 && /parse|entit|tag/i.test(err.description)) {
      await tg("sendMessage", { chat_id: chatId, text, ...extra }, signal);
    } else throw err;
  }
}

/** The outbox's sender for Telegram: each part once, resuming after the parts already sent. */
export const telegramSender: Sender = async (d, markProgress) => {
  const parts = splitText(d.text);
  const buttons = (d.meta?.buttons as Buttons | undefined) ?? undefined;
  for (let i = d.progress; i < parts.length; i++) {
    d.signal.throwIfAborted();
    const text = d.resend && i === d.progress ? `${RESEND_NOTE}\n\n${parts[i]}` : parts[i];
    await sendPart(d.destination, text, i === parts.length - 1 ? buttons : undefined, d.signal);
    await markProgress(i + 1);
  }
};

/** Keeps "typing…" showing while a run works. Telegram clears it after about 5 s. */
export function keepTyping(chatId: number | string): () => void {
  const send = () => tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
  send();
  const timer = setInterval(send, 4_500);
  return () => clearInterval(timer);
}

// ---- Webhook ---------------------------------------------------------------

export const webhookUrlFor = (siteUrl: string) => `${siteUrl.replace(/^http:\/\//, "https://").replace(/\/+$/, "")}${WEBHOOK_PATH}`;

/** Points the bot at this site. Telegram allows one webhook per bot, so only the live deploy calls this. */
export async function registerWebhook(siteUrl: string): Promise<string> {
  const url = webhookUrlFor(siteUrl);
  await tg("setWebhook", { url, secret_token: webhookSecret(), allowed_updates: ["message", "callback_query"], max_connections: 10 });
  await tg("setMyCommands", {
    commands: [
      { command: "new", description: "Start a fresh conversation (memory is kept)" },
      { command: "help", description: "What I can do" },
    ],
  }).catch(() => {});
  return url;
}

// The registration depends on the webhook URL and its secret, which follows the token.
const registrationKey = (siteUrl: string) => createHash("sha256").update(`${webhookUrlFor(siteUrl)}\n${webhookSecret()}`).digest("hex");
let confirmed: string | null = null; // the registration this instance knows is in place
let failedAt = 0;

/**
 * Points the bot at this site when the token or the site's URL changed since
 * the last registration, or always with `force` (the console's Reconnect
 * button). The console's status and pairing routes call it, so setting the
 * token, redeploying and opening the console connects the bot. Only the live
 * deploy may call it, since Telegram allows one webhook per bot.
 *
 * Netlify's deploy-succeeded event would be the obvious place, but CLI deploys
 * don't register event handlers (CLI 27.16.2 leaves `eventSubscriptions` out of
 * the deploy request), and this also covers a token changed later.
 */
export async function ensureWebhook(db: Db, siteUrl: string, opts: { force?: boolean } = {}): Promise<string | null> {
  if (!telegramConfigured()) return null;
  const key = registrationKey(siteUrl);
  if (!opts.force) {
    if (confirmed === key) return null;
    if (Date.now() - failedAt < 60_000) return null; // don't retry a failure on every page load
    if ((await getText(db, "telegram_webhook")) === key) {
      confirmed = key;
      return null;
    }
  }
  try {
    const url = await registerWebhook(siteUrl);
    await setSetting(db, "telegram_webhook", key);
    confirmed = key;
    failedAt = 0;
    return url;
  } catch (err) {
    failedAt = Date.now();
    throw err;
  }
}

export async function telegramStatus(db: Db, siteUrl: string) {
  const settings = await getSettings(db);
  if (!telegramConfigured()) return { configured: false, paired: false, botUsername: null, webhook: "unknown", lastError: null };
  const [me, hook] = await Promise.all([
    tg<{ username: string }>("getMe").catch(() => null),
    tg<{ url: string; last_error_date?: number; last_error_message?: string }>("getWebhookInfo").catch(() => null),
  ]);
  const recentError = hook?.last_error_date && Date.now() / 1000 - hook.last_error_date < 3600 ? hook.last_error_message : null;
  return {
    configured: true,
    paired: Boolean(settings.telegram),
    botUsername: me?.username ?? null,
    webhook: !hook ? "unknown" : !hook.url ? "missing" : hook.url === webhookUrlFor(siteUrl) ? "connected" : "elsewhere",
    lastError: recentError ?? null,
  };
}
