import type { Address } from "viem";
import { readState, writeState, type DetectedChange } from "./store";
import { readHolderBalances } from "./chain";

export type DeliveryReport = {
  attempted: number;
  sent: number;
  failed: number;
  /** Recipients skipped because the change did not touch their position. */
  filtered: number;
  skipped: string | null;
};

const KIND_HEADLINE: Record<DetectedChange["kind"], string> = {
  "action-scheduled": "Corporate action scheduled",
  "multiplier-applied": "Multiplier applied",
  "action-cleared": "Scheduled action withdrawn",
};

const pct = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(4)}%`;

/**
 * Alert copy. Leads with the consequence rather than the event, because the
 * holder's question is "what do I do", not "what fired".
 */
export function formatChange(change: DetectedChange): string {
  const lines = [`${KIND_HEADLINE[change.kind]} — ${change.symbol}`, ""];

  if (change.kind === "action-scheduled") {
    lines.push(
      `Multiplier will move ${change.from.toFixed(8)} → ${change.to.toFixed(8)} (${pct(change.deltaPct)}).`
    );
    if (change.effectiveAt) {
      const hours = (change.effectiveAt * 1000 - Date.now()) / 3_600_000;
      lines.push(
        hours > 0
          ? `Effective in ${hours.toFixed(1)}h (${new Date(change.effectiveAt * 1000).toUTCString()}).`
          : `Effective timestamp has already passed.`
      );
    }
    lines.push("", "This is the window to adjust collateral or exit liquidity positions.");
  } else if (change.kind === "multiplier-applied") {
    lines.push(
      `Multiplier moved ${change.from.toFixed(8)} → ${change.to.toFixed(8)} (${pct(change.deltaPct)}).`,
      "",
      "Your raw balance did not change. Effective exposure did.",
      "Any tracker or tax export reading balanceOf is now wrong by that margin."
    );
  } else {
    lines.push(
      `A pending action on ${change.symbol} was withdrawn before taking effect.`,
      `Multiplier remains ${change.to.toFixed(8)}.`
    );
  }

  return lines.join("\n");
}

/**
 * Telegram delivery.
 *
 * The only piece of the alert pipeline that needs an external credential. With
 * VELTR_TELEGRAM_BOT_TOKEN absent, dispatch is a no-op and changes stay marked
 * undelivered, so nothing is silently lost — they send once the token exists.
 */
export async function sendTelegram(
  chatId: string,
  text: string,
  options: { markdown?: boolean; replyMarkup?: unknown } = {}
): Promise<boolean> {
  const token = process.env.VELTR_TELEGRAM_BOT_TOKEN;
  if (!token) return false;

  const send = async (parseMode?: string) => {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
        ...(parseMode ? { parse_mode: parseMode } : {}),
        ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
      }),
    });
    return res;
  };

  try {
    let res = await send(options.markdown ? "Markdown" : undefined);

    // Telegram rejects the whole message if markdown is malformed — an
    // unbalanced backtick in a headline would silently lose the reply. Retry as
    // plain text so the content still reaches the user.
    if (!res.ok && options.markdown) {
      console.warn("[veltr] markdown send rejected, retrying as plain text");
      res = await send(undefined);
    }

    if (!res.ok) {
      console.warn(`[veltr] telegram ${res.status}: ${await res.text()}`);
      return false;
    }
    return true;
  } catch (error) {
    console.warn("[veltr] telegram send failed:", error);
    return false;
  }
}

/**
 * Reacts to a message.
 *
 * Acknowledgement that costs nothing and arrives instantly. A long answer is
 * still seconds away, but the reaction lands the moment the message does — so
 * the user knows it was received before any work has started.
 *
 * Telegram only accepts reactions from a fixed set for bots; anything outside
 * it is rejected, so the emoji here are drawn from that set rather than chosen
 * freely.
 */
export async function reactTo(chatId: string, messageId: number, emoji: string): Promise<void> {
  const token = process.env.VELTR_TELEGRAM_BOT_TOKEN;
  if (!token) return;

  try {
    await fetch(`https://api.telegram.org/bot${token}/setMessageReaction`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: "emoji", emoji }],
      }),
    });
  } catch {
    // Purely an acknowledgement; a failure here must never affect the reply.
  }
}

export type ChatAction = "typing" | "upload_photo";

/**
 * Shows "typing…" in the chat.
 *
 * A market answer takes several seconds to assemble from live sources. Without
 * this the bot looks dead and the user sends the question again.
 */
export async function sendTyping(chatId: string, action: ChatAction = "typing"): Promise<void> {
  const token = process.env.VELTR_TELEGRAM_BOT_TOKEN;
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action }),
    });
  } catch {
    /* cosmetic only */
  }
}

/**
 * Keeps the activity indicator alive for the whole of a slow operation.
 *
 * Telegram expires a chat action after about five seconds, so a single call
 * leaves the chat looking idle again long before a multi-source answer is ready.
 * Re-sending on a four-second beat keeps it continuous, and the interval is
 * always cleared — including when the wrapped work throws.
 */
export async function withActivity<T>(
  chatId: string,
  action: ChatAction,
  work: () => Promise<T>
): Promise<T> {
  await sendTyping(chatId, action);
  const beat = setInterval(() => void sendTyping(chatId, action), 4000);
  try {
    return await work();
  } finally {
    clearInterval(beat);
  }
}

/**
 * Registers the command menu Telegram shows when a user types "/".
 *
 * Without this the commands exist but are invisible — a user has to already
 * know they are there, which makes a terminal feel like a guessing game.
 */
export async function registerBotCommands(): Promise<boolean> {
  const token = process.env.VELTR_TELEGRAM_BOT_TOKEN;
  if (!token) return false;

  const commands = [
    { command: "price", description: "Stock price, token price and premium — /price NVDA" },
    { command: "chart", description: "Price chart from the deepest pool — /chart NVDA" },
    { command: "premium", description: "Premium table across tokenised stocks" },
    { command: "token", description: "On-chain detail: multiplier, holders, liquidity" },
    { command: "news", description: "Company headlines and SEC filings — /news NVDA" },
    { command: "market", description: "Global crypto, chain state, session" },
    { command: "splits", description: "Announced splits hitting tokenised names" },
    { command: "chain", description: "Every token on the chain by 24h volume" },
    { command: "flow", description: "Live swap flow and trade sizes — /flow NVDA" },
    { command: "delegation", description: "How the autonomous tier works" },
    { command: "positions", description: "Uniswap V3 positions the agent can defend" },
    { command: "watch", description: "Monitor a token, or scope alerts to a wallet — /watch 0x…" },
    { command: "watches", description: "Your token watchlist, live" },
    { command: "unwatch", description: "Stop watching a token, or clear the wallet scope" },
    { command: "settings", description: "Alert thresholds, interval, cooldown, sources" },
    { command: "track", description: "Watch a repo or page and tell me only when it changes" },
    { command: "tracks", description: "What you are tracking for changes" },
    { command: "mission", description: "Give me an objective and I work out the steps" },
    { command: "every", description: "Run a mission on a schedule — /every 1h <objective>" },
    { command: "schedules", description: "Your recurring missions" },
    { command: "missions", description: "Your missions and anything awaiting approval" },
    { command: "status", description: "What Veltr is currently seeing" },
    { command: "cancel", description: "Abandon the request currently running" },
    { command: "help", description: "Full command list" },
    { command: "stop", description: "Unsubscribe from alerts" },
  ];

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ commands }),
    });
    const json = await res.json();
    if (!json.ok) console.warn("[veltr] setMyCommands failed:", json.description);
    return Boolean(json.ok);
  } catch (error) {
    console.warn("[veltr] setMyCommands failed:", error);
    return false;
  }
}

/**
 * Posts a placeholder and returns its message id.
 *
 * The chat action alone is not enough feedback: it expires after five seconds,
 * renders as a thin line in the chat header, and is easy to miss entirely. A
 * real message is unmissable on every client, and it can be edited in place
 * once the answer is ready — so the user sees one message that fills in, not
 * two.
 */
export async function sendPlaceholder(chatId: string, text: string): Promise<number | null> {
  const token = process.env.VELTR_TELEGRAM_BOT_TOKEN;
  if (!token) return null;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ chat_id: chatId, text, disable_notification: true }),
    });
    const json = await res.json();
    return json?.ok ? (json.result.message_id as number) : null;
  } catch {
    return null;
  }
}

export async function editMessage(
  chatId: string,
  messageId: number,
  text: string,
  options: { markdown?: boolean; replyMarkup?: unknown } = {}
): Promise<boolean> {
  const token = process.env.VELTR_TELEGRAM_BOT_TOKEN;
  if (!token) return false;

  const attempt = async (parseMode?: string) =>
    fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        disable_web_page_preview: true,
        ...(parseMode ? { parse_mode: parseMode } : {}),
        ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
      }),
    });

  try {
    let res = await attempt(options.markdown ? "Markdown" : undefined);
    // Malformed markdown rejects the whole edit; plain text still delivers.
    if (!res.ok && options.markdown) res = await attempt(undefined);
    return res.ok;
  } catch {
    return false;
  }
}

export async function deleteMessage(chatId: string, messageId: number): Promise<void> {
  const token = process.env.VELTR_TELEGRAM_BOT_TOKEN;
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    });
  } catch {
    /* the placeholder simply stays; not worth failing over */
  }
}

/**
 * Acknowledges a button press.
 *
 * Telegram spins the button until this is called and then shows the press as
 * failed. It is a required reply, not an optional courtesy — but a failure to
 * acknowledge must never block the action the button asked for, so it is
 * fire-and-forget.
 */
export async function answerCallback(
  callbackQueryId: string,
  text?: string,
  options: { alert?: boolean } = {}
): Promise<void> {
  const token = process.env.VELTR_TELEGRAM_BOT_TOKEN;
  if (!token) return;

  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        // Telegram truncates past 200 characters and rejects nothing, so the
        // slice keeps long validation errors from arriving cut mid-word.
        ...(text ? { text: text.slice(0, 190), show_alert: Boolean(options.alert) } : {}),
      }),
    });
  } catch {
    /* the button simply stops spinning on its own */
  }
}

/** Sends an image by URL; Telegram fetches it directly. */
export async function sendPhoto(chatId: string, photoUrl: string, caption?: string): Promise<boolean> {
  const token = process.env.VELTR_TELEGRAM_BOT_TOKEN;
  if (!token) return false;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, photo: photoUrl, caption: caption?.slice(0, 1000) }),
    });
    if (!res.ok) {
      console.warn(`[veltr] sendPhoto ${res.status}: ${await res.text()}`);
      return false;
    }
    return true;
  } catch (error) {
    console.warn("[veltr] sendPhoto failed:", error);
    return false;
  }
}

/**
 * Position held by an address in the token a change affects.
 *
 * Read fresh rather than cached: a subscriber's balance is the whole basis for
 * deciding whether an alert is relevant to them, and a stale zero would
 * silently suppress the notification that matters most.
 */
async function holdingFor(address: string, token: string): Promise<number | null> {
  try {
    const [balance] = await readHolderBalances(address as Address, [token as Address]);
    if (!balance || balance.raw === 0n) return null;
    // Stock tokens are 18-decimal by specification.
    return Number(balance.effective > 0n ? balance.effective : balance.raw) / 1e18;
  } catch (error) {
    console.warn("[veltr] holding lookup failed:", error);
    return null;
  }
}

/** Appends what the change does to this specific holder's position. */
function personalise(text: string, change: DetectedChange, holding: number): string {
  const before = holding;
  const after = change.to === 0 ? holding : holding * (change.to / (change.from || 1));
  const delta = after - before;

  return [
    text,
    "",
    "— Your position —",
    `Effective exposure: ${before.toFixed(6)} → ${after.toFixed(6)}`,
    `Change: ${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(6)}`,
  ].join("\n");
}

/** Sends every undelivered change to every matching subscriber. */
export async function dispatchPending(): Promise<DeliveryReport> {
  const state = await readState();
  const pending = state.changes.filter((c) => !c.notified);

  if (pending.length === 0) {
    return { attempted: 0, sent: 0, failed: 0, filtered: 0, skipped: null };
  }
  if (!process.env.VELTR_TELEGRAM_BOT_TOKEN) {
    return {
      attempted: pending.length,
      filtered: 0,
      sent: 0,
      failed: 0,
      skipped: "VELTR_TELEGRAM_BOT_TOKEN not set — changes retained for later delivery.",
    };
  }
  if (state.subscriptions.length === 0) {
    return { attempted: pending.length, sent: 0, failed: 0, filtered: 0, skipped: "No subscriptions registered." };
  }

  let sent = 0;
  let failed = 0;
  let filtered = 0;
  const delivered = new Set<string>();

  // An alert is a push, not a reply. When an owner is configured, nobody else
  // receives one — the subscription list is otherwise whoever happened to have
  // pressed /start, which after a deploy is not who the operator meant.
  const { allowedRecipients } = await import("./owner");
  const permitted = new Set(
    await allowedRecipients(state.subscriptions.map((s) => s.destination))
  );
  const recipients = state.subscriptions.filter((s) => permitted.has(s.destination));

  if (recipients.length === 0) {
    return {
      attempted: pending.length,
      sent: 0,
      failed: 0,
      filtered: state.subscriptions.length,
      skipped: "Push restricted to the configured owner; no permitted recipient.",
    };
  }

  for (const change of pending) {
    const base = formatChange(change);
    let anySucceeded = false;

    for (const sub of recipients) {
      if (Math.abs(change.deltaPct) < sub.minDeltaPct) {
        filtered++;
        continue;
      }

      let text = base;

      // An address-scoped subscriber only hears about tokens they actually hold,
      // and the alert is rewritten in terms of their own position.
      if (sub.address) {
        const holding = await holdingFor(sub.address, change.token);
        if (holding === null) {
          filtered++;
          continue;
        }
        text = personalise(base, change, holding);
      }

      const ok = await sendTelegram(sub.destination, text);
      if (ok) {
        sent++;
        anySucceeded = true;
      } else {
        failed++;
      }
    }
    // Retire a change once it reached someone, or once every subscriber
    // legitimately filtered it out — otherwise it would retry forever.
    if (anySucceeded || (failed === 0 && filtered > 0)) delivered.add(change.id);
  }

  await writeState({
    ...state,
    changes: state.changes.map((c) => (delivered.has(c.id) ? { ...c, notified: true } : c)),
  });

  return { attempted: pending.length, sent, failed, filtered, skipped: null };
}
