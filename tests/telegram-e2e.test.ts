import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The bot, end to end, with Telegram replaced.
 *
 * Every outbound call — sendMessage, sendDocument, editMessageText,
 * setMessageReaction — goes through global fetch, so intercepting it exercises
 * the real handlers and shows exactly what would have reached Telegram. The only
 * thing not proved here is how Telegram renders it.
 *
 * This exists because three fixes were shipped without ever being seen working
 * in a chat, the most important being a bot that said it had sent a file and had
 * not. That failure is now a test.
 */

const sandbox = mkdtempSync(join(tmpdir(), "veltr-e2e-"));
mkdirSync(join(sandbox, "data"), { recursive: true });
process.chdir(sandbox);

writeFileSync(
  join(sandbox, "data", "watcher-state.json"),
  JSON.stringify({
    lastMultiplier: {},
    lastPending: {},
    seenActionIds: [],
    changes: [],
    subscriptions: [
      { id: "a", address: null, channel: "telegram", destination: "555", minDeltaPct: 0, createdAt: "2026-01-01T00:00:00.000Z" },
    ],
    lastRunAt: null,
    lastBlock: null,
    lastTelegramUpdateId: 100,
    lastBriefSentOn: null,
  }),
  "utf8"
);

process.env.VELTR_TELEGRAM_BOT_TOKEN = "test-token";
// A gateway must exist or `complete()` filters them all out and returns null
// before the interceptor is ever reached. The key is never sent anywhere.
process.env.VELTR_VIRTUALS_API_KEY = "test-key";
// Off, so the harness is not waiting a second per message for a cosmetic pause.
process.env.VELTR_REACT_DELAY_MS = "0";
// The push restriction is exercised in owner.test.ts; here it must not suppress
// the replies being asserted.
delete process.env.VELTR_OWNER_USERNAME;
delete process.env.VELTR_OWNER_CHAT_ID;

const CHAT = "555";

type Captured = { method: string; body: Record<string, unknown>; form?: Record<string, string> };

/** Records Telegram traffic and answers it, so no request leaves the process. */
function intercept(options: { updates?: unknown[]; llm?: string } = {}) {
  const calls: Captured[] = [];
  const real = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("api.telegram.org")) {
      const method = url.split("/").pop()!.split("?")[0];
      const captured: Captured = { method, body: {} };

      if (init?.body instanceof FormData) {
        captured.form = {};
        for (const [k, v] of init.body.entries()) {
          captured.form[k] = v instanceof Blob ? await v.text() : String(v);
        }
      } else if (typeof init?.body === "string") {
        captured.body = JSON.parse(init.body);
      }

      calls.push(captured);

      const result =
        method === "getUpdates"
          ? options.updates ?? []
          : method === "sendMessage" || method === "sendDocument"
            ? { message_id: 900 + calls.length }
            : true;

      return new Response(JSON.stringify({ ok: true, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // The model gateway, when a test needs one.
    if (url.includes("/chat/completions")) {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: options.llm ?? "ok" }, finish_reason: "stop" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  return { calls, restore: () => void (globalThis.fetch = real) };
}

const message = (id: number, text: string) => ({
  update_id: id,
  message: { message_id: id, chat: { id: Number(CHAT), first_name: "Dimas" }, from: { username: "someone" }, text },
});

const press = (id: number, data: string) => ({
  update_id: id,
  callback_query: { id: `cb-${id}`, data, message: { message_id: 800, chat: { id: Number(CHAT) } } },
});

const { syncTelegram } = await import("../lib/telegram");

/* ------------------------------------------------- The original bug */

test("write_code with deliverAs actually uploads a document", async () => {
  const html = "<!doctype html><title>Dika & Rezz</title><h1>Premium Console</h1>";
  const net = intercept({ llm: html });

  try {
    const { invokeTool } = await import("../lib/tools");
    const result = (await invokeTool(
      "write_code",
      { instruction: "premium terminal UI console page", language: "html", deliverAs: "index.html" },
      { chatId: CHAT }
    )) as { result: Record<string, unknown> };

    const upload = net.calls.find((c) => c.method === "sendDocument");

    assert.ok(upload, "the whole bug was that this request was never made");
    assert.equal(upload.form?.chat_id, CHAT);
    assert.equal(upload.form?.document, html, "the generated file is what was uploaded");
    assert.equal(result.result.sent, true);
    assert.equal(result.result.filename, "index.html");
  } finally {
    net.restore();
  }
});

test("a delivery that fails is never reported as sent", async () => {
  const net = intercept({ llm: "<html></html>" });
  const real = globalThis.fetch;

  // Telegram accepts the request and rejects the document.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("sendDocument")) return new Response("nope", { status: 400 });
    return real(input as string, init);
  }) as typeof fetch;

  try {
    const { invokeTool } = await import("../lib/tools");
    const invocation = (await invokeTool(
      "write_code",
      { instruction: "a page", deliverAs: "index.html" },
      { chatId: CHAT }
    )) as { result: Record<string, unknown> };

    assert.ok(invocation.result.error, "a failed upload must surface as an error");
    assert.notEqual(invocation.result.sent, true);
  } finally {
    net.restore();
  }
});

/* --------------------------------------------------- Commands and buttons */

test("/settings sends a panel with the inline keyboard attached", async () => {
  const net = intercept({ updates: [message(101, "/settings")] });

  try {
    await syncTelegram(0);

    const sent = net.calls.find((c) => c.method === "sendMessage");
    assert.ok(sent, "the command produced no message at all");

    const text = String(sent.body.text);
    assert.match(text, /Veltr Watch Settings/);
    assert.match(text, /Price Up: \+10%/);

    const keyboard = (sent.body.reply_markup as { inline_keyboard: { callback_data: string }[][] })
      ?.inline_keyboard;
    assert.ok(keyboard?.length, "the buttons are the whole feature");
    assert.ok(
      keyboard.flat().some((b) => b.callback_data === "w:f:priceUpPct"),
      "the Up threshold button must be present and routable"
    );
  } finally {
    net.restore();
  }
});

test("pressing a settings button acknowledges it and edits the panel in place", async () => {
  const net = intercept({ updates: [press(102, "w:f:priceUpPct")] });

  try {
    await syncTelegram(0);

    const answered = net.calls.find((c) => c.method === "answerCallbackQuery");
    assert.ok(answered, "Telegram spins the button forever without this");

    const edited = net.calls.find((c) => c.method === "editMessageText");
    assert.ok(edited, "the panel is navigated in place, not by stacking messages");
    assert.equal(edited.body.message_id, 800);
    assert.match(String(edited.body.text), /Set Price Up/);

    const options = (edited.body.reply_markup as { inline_keyboard: { callback_data: string }[][] })
      .inline_keyboard.flat();
    assert.ok(options.some((b) => b.callback_data === "w:s:priceUpPct:20"), "presets must be offered");
    assert.ok(options.some((b) => b.callback_data === "w:c:priceUpPct"), "and a custom option");
  } finally {
    net.restore();
  }
});

test("choosing a preset stores it and shows the updated panel", async () => {
  const net = intercept({ updates: [press(103, "w:s:priceUpPct:20")] });

  try {
    await syncTelegram(0);

    const edited = net.calls.find((c) => c.method === "editMessageText");
    assert.match(String(edited?.body.text), /Price Up: \+20%/);

    const { getSettings } = await import("../lib/watch/store");
    assert.equal((await getSettings(CHAT)).priceUpPct, 20, "and it survived to the store");
  } finally {
    net.restore();
  }
});

test("a forged callback cannot reach a field that does not exist", async () => {
  const net = intercept({ updates: [press(104, "w:s:__proto__:1")] });

  try {
    await syncTelegram(0);
    const edited = net.calls.find((c) => c.method === "editMessageText");
    assert.equal(edited, undefined, "nothing should have been changed or re-rendered");
  } finally {
    net.restore();
  }
});

/* ----------------------------------------------------------- Reactions */

test("an inbound message is reacted to before any work begins", async () => {
  const net = intercept({ updates: [message(105, "/settings")] });

  try {
    await syncTelegram(0);

    const reaction = net.calls.find((c) => c.method === "setMessageReaction");
    assert.ok(reaction, "the acknowledgement never went out");
    assert.equal(reaction.body.message_id, 105);

    const emoji = (reaction.body.reaction as { emoji: string }[])[0]?.emoji;
    assert.ok(emoji, "a reaction with no emoji is rejected by Telegram");
  } finally {
    net.restore();
  }
});

/* -------------------------------------------------------------- /watches */

test("/watches reports an empty list rather than failing", async () => {
  const net = intercept({ updates: [message(106, "/watches")] });

  try {
    await syncTelegram(0);
    const sent = net.calls.filter((c) => c.method === "sendMessage").pop();
    assert.match(String(sent?.body.text), /Nothing watched yet/);
  } finally {
    net.restore();
  }
});

test("the long-poll cursor advances so a message is never handled twice", async () => {
  const net = intercept({ updates: [message(107, "/settings")] });

  try {
    await syncTelegram(0);
    const { readState } = await import("../lib/store");
    assert.equal((await readState()).lastTelegramUpdateId, 107);
  } finally {
    net.restore();
  }
});
