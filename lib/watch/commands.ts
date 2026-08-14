import { isAddress } from "viem";
import { publicClient } from "../chain";
import { fetchTokenMarketData, CHAIN_ID } from "./aggregate";
import {
  renderAlert,
  renderSettings,
  renderWatchConfirmation,
  renderWatchlist,
  tokenLabel,
  TOKEN_NOT_FOUND,
  formatPrice,
  formatMoney,
  formatPct,
} from "./format";
import {
  addWatch,
  findWatch,
  getSettings,
  listWatches,
  removeWatch,
  resetSettings,
  updateSettings,
} from "./store";
import {
  FIELD_LABELS,
  formatFieldValue,
  parseNumericInput,
  validateField,
  type NumericField,
} from "./settings";
import {
  customPrompt,
  fieldKeyboard,
  fieldPrompt,
  parseCallback,
  settingsKeyboard,
  watchKeyboard,
  watchlistKeyboard,
  type InlineKeyboard,
} from "./keyboard";
import type { TokenMarketData, TokenWatch, WatchSettings } from "./types";

/**
 * Command layer for the watch feature.
 *
 * Returns rendered replies rather than sending them, so the Telegram transport
 * stays in one place and every branch below is testable without a bot token.
 *
 * Identity is the Telegram chat id throughout — the same key the existing
 * subscription list uses, and the address alerts are delivered to. In a private
 * chat that is exactly one person. In a group it is the group, which is the
 * correct scope there: everyone in the room already receives the same alerts.
 */

export type Reply = {
  text: string;
  keyboard?: InlineKeyboard;
  /** True when this should replace the message the button was attached to. */
  edit?: boolean;
  /**
   * Set when the address is not an indexed token. The caller uses it to fall
   * back to the older meaning of /watch rather than leaving the user with an
   * error for a command that used to work.
   */
  notFound?: boolean;
};

/* -------------------------------------------------------- Address kinds */

export type AddressKind = "contract" | "wallet" | "invalid";

/**
 * First pass at telling a token contract from a wallet.
 *
 * `/watch <address>` already meant "scope my corporate-action alerts to this
 * wallet" before this feature existed, and that meaning cannot break under
 * anyone using it.
 *
 * Bytecode alone does not settle it. Accounts on this chain are frequently
 * contracts — the address in the original documentation for this command is a
 * ZkLighter proxy, a smart-contract wallet — so "has code" would misroute a real
 * user's wallet into a token lookup. This is therefore only a cheap first filter:
 * an account with no code is certainly a wallet and skips the market lookup
 * entirely, while a contract goes on to be judged by whether it actually trades.
 *
 * On an RPC failure the answer is "wallet", which preserves the older behaviour —
 * the conservative direction, since it changes nothing for existing users.
 */
export async function classifyAddress(address: string): Promise<AddressKind> {
  if (!isAddress(address)) return "invalid";

  try {
    const code = await publicClient.getCode({ address: address as `0x${string}` });
    return code && code !== "0x" ? "contract" : "wallet";
  } catch (error) {
    console.warn(
      `[veltr][WATCH] bytecode lookup failed token=${address}:`,
      error instanceof Error ? error.message : error
    );
    return "wallet";
  }
}

/* --------------------------------------------------------------- /watch */

export async function handleWatch(userId: string, rawAddress: string): Promise<Reply> {
  const address = rawAddress.trim();

  if (!isAddress(address)) {
    return {
      text: [
        "Send a valid contract address.",
        "",
        "/watch 0x2e8c31162b855a2ffa90f6f8634643ad6f111e18",
        "",
        "Robinhood Chain (id " + CHAIN_ID + ") token addresses are ordinary EVM addresses.",
      ].join("\n"),
    };
  }

  const settings = await getSettings(userId);
  console.log(`[veltr][WATCH] lookup user=${userId} token=${address}`);

  const market = await fetchTokenMarketData(address, { settings, deep: true });

  if (!market || market.priceUsd === null) {
    return { text: TOKEN_NOT_FOUND, notFound: true };
  }

  const result = await addWatch({
    userId,
    tokenAddress: address,
    symbol: market.symbol,
    name: market.name,
    pairAddress: market.pairAddress,
    price: market.priceUsd,
    marketCap: market.marketCap ?? market.fdv,
    liquidity: market.liquidity,
    volume24h: market.volume24h,
  });

  if (!result.ok) return { text: result.error };

  console.log(
    `[veltr][WATCH] added user=${userId} token=${address} symbol=${market.symbol ?? "?"} baseline=${market.priceUsd}`
  );

  return {
    text: renderWatchConfirmation(result.watch, market, settings, result.alreadyWatched),
    keyboard: watchKeyboard(result.watch),
  };
}

/* ------------------------------------------------------------- /unwatch */

export async function handleUnwatch(userId: string, rawAddress: string): Promise<Reply> {
  const address = rawAddress.trim();

  if (!isAddress(address)) {
    const watches = await listWatches(userId);
    if (watches.length === 0) {
      return { text: "You are not watching any tokens. Add one with /watch <contract address>." };
    }
    return {
      text: "Which token should I stop watching?",
      keyboard: watchlistKeyboard(watches),
    };
  }

  const removed = await removeWatch(userId, address);
  if (!removed) {
    return { text: "That token is not on your watchlist. Send /watches to see what is." };
  }

  console.log(`[veltr][WATCH] removed user=${userId} token=${address}`);
  return { text: `Stopped watching ${tokenLabel(removed)}.` };
}

/* ------------------------------------------------------------- /watches */

export async function handleWatches(userId: string): Promise<Reply> {
  const [watches, settings] = await Promise.all([listWatches(userId), getSettings(userId)]);
  return {
    text: renderWatchlist(watches, settings),
    keyboard: watches.length > 0 ? watchlistKeyboard(watches) : settingsKeyboard(settings),
  };
}

/* ------------------------------------------------------------ /settings */

export async function handleSettings(userId: string, arg = ""): Promise<Reply> {
  if (arg.trim().toLowerCase() === "reset") {
    const settings = await resetSettings(userId);
    const watches = await listWatches(userId);
    console.log(`[veltr][SETTINGS] reset user=${userId}`);
    return {
      text: "Settings restored to defaults.\n\n" + renderSettings(settings, watches.length),
      keyboard: settingsKeyboard(settings),
    };
  }

  const [settings, watches] = await Promise.all([getSettings(userId), listWatches(userId)]);
  return { text: renderSettings(settings, watches.length), keyboard: settingsKeyboard(settings) };
}

/* -------------------------------------------------- Custom value prompts */

type Pending = { field: NumericField; askedAt: number };

/**
 * Chats awaiting a typed threshold.
 *
 * Deliberately in memory and short-lived. A prompt is a conversational turn, not
 * a setting: persisting it would mean a restart silently swallowing the next
 * unrelated message a user sent, days later, as though it were an answer.
 */
const pending = new Map<string, Pending>();
const PENDING_TTL_MS = 5 * 60_000;

export function expectCustomValue(userId: string, field: NumericField): void {
  pending.set(userId, { field, askedAt: Date.now() });
}

export function cancelPending(userId: string): boolean {
  return pending.delete(userId);
}

export function hasPending(userId: string): boolean {
  const entry = pending.get(userId);
  if (!entry) return false;
  if (Date.now() - entry.askedAt > PENDING_TTL_MS) {
    pending.delete(userId);
    return false;
  }
  return true;
}

/** Test seam: drops every outstanding prompt. */
export function clearPending(): void {
  pending.clear();
}

/**
 * Consumes a typed threshold, if one was asked for.
 *
 * Returns null when this chat was not asked anything, so the caller can pass the
 * message on to the agent untouched — a stale prompt must never capture an
 * ordinary question.
 */
export async function handleCustomValue(userId: string, text: string): Promise<Reply | null> {
  if (!hasPending(userId)) return null;
  const entry = pending.get(userId)!;

  const trimmed = text.trim();
  if (trimmed.toLowerCase() === "/cancel") {
    pending.delete(userId);
    return { text: `Left ${FIELD_LABELS[entry.field]} unchanged.` };
  }

  const parsed = parseNumericInput(trimmed);
  if (parsed === null) {
    return {
      text: `That is not a number I can read. Send a value for ${FIELD_LABELS[entry.field]}, or /cancel.`,
    };
  }

  const check = validateField(entry.field, parsed);
  if (!check.ok) return { text: `${check.error}\n\nSend another value, or /cancel.` };

  pending.delete(userId);
  const settings = await updateSettings(userId, { [entry.field]: check.value } as Partial<WatchSettings>);
  const watches = await listWatches(userId);

  console.log(
    `[veltr][SETTINGS] user=${userId} field=${entry.field} value=${check.value} source=custom`
  );

  return {
    text: `${FIELD_LABELS[entry.field]} set to ${formatFieldValue(entry.field, settings)}.\n\n${renderSettings(
      settings,
      watches.length
    )}`,
    keyboard: settingsKeyboard(settings),
  };
}

/* -------------------------------------------------------------- Buttons */

export type CallbackOutcome = {
  reply: Reply | null;
  /** Short toast shown on the button itself. */
  toast?: string;
};

/**
 * Routes a button press.
 *
 * `userId` is taken from the chat the keyboard lives in, never from the payload,
 * so a crafted callback cannot address another user's watchlist: the worst a
 * forged payload achieves is editing the sender's own settings, which they can
 * do with the buttons anyway.
 */
export async function handleCallbackData(userId: string, data: string): Promise<CallbackOutcome> {
  const callback = parseCallback(data);
  if (!callback) return { reply: null, toast: "Unrecognised button." };

  switch (callback.kind) {
    case "noop":
      return { reply: null };

    case "menu": {
      const reply = await handleSettings(userId);
      return { reply: { ...reply, edit: true } };
    }

    case "list": {
      const reply = await handleWatches(userId);
      return { reply: { ...reply, edit: true }, toast: "Refreshed" };
    }

    case "field": {
      return {
        reply: {
          text: fieldPrompt(callback.field),
          keyboard: fieldKeyboard(callback.field),
          edit: true,
        },
      };
    }

    case "custom": {
      expectCustomValue(userId, callback.field);
      return { reply: { text: customPrompt(callback.field) }, toast: "Send a value" };
    }

    case "set": {
      const { field, value } = callback;

      if (value !== null) {
        const check = validateField(field, value);
        if (!check.ok) return { reply: null, toast: check.error };
      }

      const settings = await updateSettings(userId, { [field]: value } as Partial<WatchSettings>);
      const watches = await listWatches(userId);

      console.log(
        `[veltr][SETTINGS] user=${userId} field=${field} value=${value ?? "disabled"} source=preset`
      );

      return {
        reply: {
          text: renderSettings(settings, watches.length),
          keyboard: settingsKeyboard(settings),
          edit: true,
        },
        toast: `${FIELD_LABELS[field]}: ${formatFieldValue(field, settings)}`,
      };
    }

    case "toggleSource": {
      const current = await getSettings(userId);
      const key = callback.source === "ds" ? "useDexScreener" : "useGeckoTerminal";
      const other = callback.source === "ds" ? "useGeckoTerminal" : "useDexScreener";

      // Turning off the last source would stop every alert without saying so.
      if (current[key] && !current[other]) {
        return { reply: null, toast: "At least one data source must stay enabled." };
      }

      const settings = await updateSettings(userId, { [key]: !current[key] } as Partial<WatchSettings>);
      const watches = await listWatches(userId);

      console.log(`[veltr][SETTINGS] user=${userId} field=${key} value=${settings[key]}`);

      return {
        reply: {
          text: renderSettings(settings, watches.length),
          keyboard: settingsKeyboard(settings),
          edit: true,
        },
        toast: `${callback.source === "ds" ? "DEX Screener" : "GeckoTerminal"} ${settings[key] ? "on" : "off"}`,
      };
    }

    case "reset": {
      const reply = await handleSettings(userId, "reset");
      return { reply: { ...reply, edit: true }, toast: "Defaults restored" };
    }

    case "unwatch": {
      const reply = await handleUnwatch(userId, callback.address);
      const watches = await listWatches(userId);
      const settings = await getSettings(userId);
      return {
        reply: {
          text: `${reply.text}\n\n${renderWatchlist(watches, settings)}`,
          keyboard: watches.length > 0 ? watchlistKeyboard(watches) : settingsKeyboard(settings),
          edit: true,
        },
        toast: "Unwatched",
      };
    }

    case "view":
    case "refresh": {
      const reply = await renderSingleWatch(userId, callback.address);
      return { reply: { ...reply, edit: true }, toast: "Refreshed" };
    }
  }
}

/**
 * Live view of one watched token.
 *
 * Reads through the aggregator rather than the stored snapshot: a user pressing
 * refresh is asking what the price is now, not what it was when the monitor last
 * looked.
 */
export async function renderSingleWatch(userId: string, address: string): Promise<Reply> {
  const watch = await findWatch(userId, address);
  if (!watch) return { text: "That token is not on your watchlist." };

  const settings = await getSettings(userId);
  const market = await fetchTokenMarketData(watch.tokenAddress, { settings, deep: true });

  if (!market || market.priceUsd === null) {
    return {
      text: [
        `${tokenLabel(watch)} — no live reading right now.`,
        "",
        `Last seen: ${formatPrice(watch.lastPrice)}`,
        watch.lastCheckedAt ? `Checked: ${watch.lastCheckedAt}` : "",
        "",
        "Both market sources are unavailable or the pair is no longer indexed. Monitoring continues.",
      ]
        .filter(Boolean)
        .join("\n"),
      keyboard: watchKeyboard(watch),
    };
  }

  return { text: renderLiveView(watch, market), keyboard: watchKeyboard(watch) };
}

function renderLiveView(watch: TokenWatch, market: TokenMarketData): string {
  const sinceWatch =
    watch.baselinePrice && market.priceUsd
      ? (market.priceUsd / watch.baselinePrice - 1) * 100
      : null;

  return [
    `👁 ${tokenLabel(watch)}${market.name ? ` — ${market.name}` : ""}`,
    "",
    `Price: ${formatPrice(market.priceUsd)}`,
    `Since watch: ${formatPct(sinceWatch)}`,
    "",
    `MC: ${formatMoney(market.marketCap ?? market.fdv)}`,
    `Liquidity: ${formatMoney(market.liquidity)}`,
    `24h Volume: ${formatMoney(market.volume24h)}`,
    "",
    `5m ${formatPct(market.priceChange5m)}   1h ${formatPct(market.priceChange1h)}`,
    `6h ${formatPct(market.priceChange6h)}   24h ${formatPct(market.priceChange24h)}`,
    market.buys !== null || market.sells !== null
      ? `\nTrades 24h: ${market.buys ?? "?"} buys / ${market.sells ?? "?"} sells`
      : "",
    market.url ? `\n${market.url}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** Re-exported so the transport can render an alert without reaching into format. */
export { renderAlert };
