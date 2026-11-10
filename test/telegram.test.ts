import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDatabase, type TestDatabase } from "./helpers.ts";

// Connecting the webhook from the server: once per token and URL, remembered
// across instances, and again when either changes.

let t: TestDatabase;
let calls: { method: string; params: any }[] = [];
let failNext = false;

beforeEach(async () => {
  t = await freshDatabase();
  calls = [];
  failNext = false;
  process.env.TELEGRAM_BOT_TOKEN = "123:first";
  vi.resetModules(); // each test starts as a fresh instance
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const method = String(url).split("/").pop()!;
    calls.push({ method, params: JSON.parse(String(init.body)) });
    if (failNext && method === "setWebhook") {
      failNext = false;
      return new Response(JSON.stringify({ ok: false, description: "Bad Request" }), { status: 400 });
    }
    return new Response(JSON.stringify({ ok: true, result: true }));
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.TELEGRAM_BOT_TOKEN;
  await t.close();
});

const instance = async () => {
  vi.resetModules();
  return import("../src/channels/telegram.ts");
};
const registrations = () => calls.filter((c) => c.method === "setWebhook");

describe("ensureWebhook", () => {
  it("connects once per token and URL, also across instances", async () => {
    const db = t.connect();
    const a = await instance();
    expect(await a.ensureWebhook(db, "https://example.netlify.app")).toBe("https://example.netlify.app/telegram/webhook");
    expect(registrations()).toHaveLength(1);
    expect(registrations()[0].params.secret_token).toBe(a.webhookSecret());

    // The same instance, and a new one after a deploy, see it's done.
    await a.ensureWebhook(db, "https://example.netlify.app");
    const b = await instance();
    expect(await b.ensureWebhook(db, "https://example.netlify.app")).toBeNull();
    expect(registrations()).toHaveLength(1);

    // A new token changes the secret, and a renamed site changes the URL.
    process.env.TELEGRAM_BOT_TOKEN = "123:second";
    await b.ensureWebhook(db, "https://example.netlify.app");
    await b.ensureWebhook(db, "https://renamed.netlify.app");
    expect(registrations().map((r) => r.params.url)).toEqual([
      "https://example.netlify.app/telegram/webhook",
      "https://example.netlify.app/telegram/webhook",
      "https://renamed.netlify.app/telegram/webhook",
    ]);

    // Reconnect always registers.
    await b.ensureWebhook(db, "https://renamed.netlify.app", { force: true });
    expect(registrations()).toHaveLength(4);
  });

  it("reports a failure and doesn't retry it on every call", async () => {
    const db = t.connect();
    const a = await instance();
    failNext = true;
    await expect(a.ensureWebhook(db, "https://example.netlify.app")).rejects.toThrow(/setWebhook failed/);
    expect(await a.ensureWebhook(db, "https://example.netlify.app")).toBeNull(); // within the minute
    expect(registrations()).toHaveLength(1);
    // Reconnect doesn't wait.
    await a.ensureWebhook(db, "https://example.netlify.app", { force: true });
    expect(registrations()).toHaveLength(2);
  });

  it("does nothing without a token", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const a = await instance();
    expect(await a.ensureWebhook(t.connect(), "https://example.netlify.app")).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
