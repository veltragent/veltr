import {
  COOLDOWN_PRESETS_SEC,
  FIELD_LABELS,
  FIELD_UNIT,
  INTERVAL_PRESETS_SEC,
  MONEY_PRESETS,
  PCT_PRESETS,
  formatDuration,
  formatFieldValue,
  formatUsd,
  isNumericField,
  type NumericField,
} from "./settings";
import type { TokenWatch, WatchSettings } from "./types";

/**
 * Inline keyboards and their callback vocabulary.
 *
 * Telegram caps `callback_data` at 64 bytes, so the scheme is terse by necessity:
 * a namespace, a verb, and at most two arguments. The namespace exists because
 * this bot may grow other keyboards, and an unprefixed "reset" arriving from
 * somewhere else must not reach these handlers.
 */

export const NS = "w";

export type InlineButton = { text: string; callback_data: string };
export type InlineKeyboard = { inline_keyboard: InlineButton[][] };

export type Callback =
  | { kind: "menu" }
  | { kind: "field"; field: NumericField }
  | { kind: "set"; field: NumericField; value: number | null }
  | { kind: "custom"; field: NumericField }
  | { kind: "toggleSource"; source: "ds" | "gt" }
  | { kind: "reset" }
  | { kind: "list" }
  | { kind: "unwatch"; address: string }
  | { kind: "refresh"; address: string }
  | { kind: "view"; address: string }
  | { kind: "noop" };

/**
 * Parses callback data.
 *
 * Everything arriving here is attacker-controlled: a callback payload can be
 * replayed or hand-crafted by anyone who can talk to the bot. Nothing is trusted
 * past its shape — the field name is checked against the known set, the value
 * must parse as finite, and an address must look like one. Authorisation is not
 * done here: the caller pairs this with the chat the keyboard belongs to.
 */
export function parseCallback(data: string): Callback | null {
  if (typeof data !== "string" || data.length > 64) return null;
  const parts = data.split(":");
  if (parts[0] !== NS) return null;

  switch (parts[1]) {
    case "menu":
      return { kind: "menu" };
    case "list":
      return { kind: "list" };
    case "reset":
      return { kind: "reset" };
    case "noop":
      return { kind: "noop" };

    case "f":
      return parts[2] && isNumericField(parts[2]) ? { kind: "field", field: parts[2] } : null;

    case "c":
      return parts[2] && isNumericField(parts[2]) ? { kind: "custom", field: parts[2] } : null;

    case "s": {
      if (!parts[2] || !isNumericField(parts[2])) return null;
      if (parts[3] === "off") return { kind: "set", field: parts[2], value: null };
      const value = Number(parts[3]);
      return Number.isFinite(value) ? { kind: "set", field: parts[2], value } : null;
    }

    case "t":
      return parts[2] === "ds" || parts[2] === "gt" ? { kind: "toggleSource", source: parts[2] } : null;

    case "u":
    case "r":
    case "v": {
      const address = parts[2] ?? "";
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
      const kind = parts[1] === "u" ? "unwatch" : parts[1] === "r" ? "refresh" : "view";
      return { kind, address: address.toLowerCase() } as Callback;
    }

    default:
      return null;
  }
}

/* ------------------------------------------------------------- Builders */

export function settingsKeyboard(settings: WatchSettings): InlineKeyboard {
  const field = (label: string, name: NumericField): InlineButton => ({
    text: `${label} ${formatFieldValue(name, settings)}`,
    callback_data: `${NS}:f:${name}`,
  });

  return {
    inline_keyboard: [
      [field("🟢 UP", "priceUpPct"), field("🔴 DOWN", "priceDownPct")],
      [field("📈 MC ABOVE", "marketCapAbove"), field("📉 MC BELOW", "marketCapBelow")],
      [field("💧 LIQ ABOVE", "liquidityAbove"), field("💧 LIQ BELOW", "liquidityBelow")],
      [field("📊 VOL ABOVE", "volumeAbove"), field("📊 VOL BELOW", "volumeBelow")],
      [field("⏱ INTERVAL", "checkIntervalSec"), field("🔕 COOLDOWN", "alertCooldownSec")],
      [
        {
          text: `${settings.useDexScreener ? "🟢" : "🔴"} DEX Screener`,
          callback_data: `${NS}:t:ds`,
        },
        {
          text: `${settings.useGeckoTerminal ? "🟢" : "🔴"} GeckoTerminal`,
          callback_data: `${NS}:t:gt`,
        },
      ],
      [
        { text: "👁 WATCHLIST", callback_data: `${NS}:list` },
        { text: "🔄 RESET", callback_data: `${NS}:reset` },
      ],
    ],
  };
}

function presetsFor(field: NumericField): number[] {
  switch (FIELD_UNIT[field]) {
    case "pct":
      return PCT_PRESETS;
    case "usd":
      return MONEY_PRESETS;
    default:
      return field === "checkIntervalSec" ? INTERVAL_PRESETS_SEC : COOLDOWN_PRESETS_SEC;
  }
}

function presetLabel(field: NumericField, value: number): string {
  switch (FIELD_UNIT[field]) {
    case "pct":
      return `${field === "priceDownPct" ? "−" : "+"}${value}%`;
    case "usd":
      return formatUsd(value);
    default:
      return formatDuration(value);
  }
}

export function fieldKeyboard(field: NumericField): InlineKeyboard {
  const presets = presetsFor(field);
  const rows: InlineButton[][] = [];

  for (let i = 0; i < presets.length; i += 2) {
    rows.push(
      presets.slice(i, i + 2).map((value) => ({
        text: presetLabel(field, value),
        callback_data: `${NS}:s:${field}:${value}`,
      }))
    );
  }

  rows.push([{ text: "✏️ Custom", callback_data: `${NS}:c:${field}` }]);

  // The interval is the one setting with no "off": a watch that is never checked
  // is a watch that silently does nothing.
  if (field !== "checkIntervalSec") {
    rows.push([{ text: "🚫 Disable", callback_data: `${NS}:s:${field}:off` }]);
  }

  rows.push([{ text: "← Back", callback_data: `${NS}:menu` }]);
  return { inline_keyboard: rows };
}

export function fieldPrompt(field: NumericField): string {
  const label = FIELD_LABELS[field];
  switch (FIELD_UNIT[field]) {
    case "pct":
      return `Set ${label}\n\nPick a preset, or send a custom percentage.`;
    case "usd":
      return `Set ${label}\n\nPick a preset, or send a custom dollar amount.`;
    default:
      return `Set ${label}\n\nPick a preset, or send a custom duration in seconds.`;
  }
}

export function customPrompt(field: NumericField): string {
  const label = FIELD_LABELS[field];
  switch (FIELD_UNIT[field]) {
    case "pct":
      return [
        `Send the percentage for ${label}.`,
        "",
        "Examples:  7.5   15   0.5",
        "",
        "Send /cancel to leave it unchanged.",
      ].join("\n");
    case "usd":
      return [
        `Send the dollar threshold for ${label}.`,
        "",
        "Examples:  250000   250k   1.5M   $12,500",
        "",
        "Send /cancel to leave it unchanged.",
      ].join("\n");
    default:
      return [
        `Send the number of seconds for ${label}.`,
        "",
        "Examples:  30   120   900",
        "",
        "Send /cancel to leave it unchanged.",
      ].join("\n");
  }
}

/** Buttons under the watchlist: one row per token, plus the settings entry. */
export function watchlistKeyboard(watches: TokenWatch[]): InlineKeyboard {
  const rows: InlineButton[][] = watches.slice(0, 10).map((watch) => {
    const label = watch.symbol ? `$${watch.symbol}` : watch.tokenAddress.slice(0, 8);
    return [
      { text: `🔄 ${label}`, callback_data: `${NS}:r:${watch.tokenAddress}` },
      { text: "👁 View", callback_data: `${NS}:v:${watch.tokenAddress}` },
      { text: "✖ Unwatch", callback_data: `${NS}:u:${watch.tokenAddress}` },
    ];
  });

  rows.push([
    { text: "⚙️ Settings", callback_data: `${NS}:menu` },
    { text: "🔄 Refresh all", callback_data: `${NS}:list` },
  ]);

  return { inline_keyboard: rows };
}

/** Buttons under a single token view. */
export function watchKeyboard(watch: TokenWatch): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: "🔄 Refresh", callback_data: `${NS}:r:${watch.tokenAddress}` },
        { text: "⚙️ Settings", callback_data: `${NS}:menu` },
      ],
      [
        { text: "👁 Watchlist", callback_data: `${NS}:list` },
        { text: "✖ Unwatch", callback_data: `${NS}:u:${watch.tokenAddress}` },
      ],
    ],
  };
}
